import { describe, expect, it } from 'vitest'
import { checkTidyUpOps, memorySnapshot } from './bot-memory-ops'
import { parseTidyUpOps } from './bot-memory-ops-reply'
import { memoryFitsOps, ownerTypedSegments } from './bot-memory-ops-pilot'
import { statusMigrationPlan } from './bot-memory-status-migration'
import { fileKeptOutLines, linesToKeepOut } from './bot-memory-readd-guard'
import { tidyUpSummaryOf } from './bot-memory-tidy-up-draft'
import { tidyUpOpsPrompt } from './bot-memory-tidy-up-ops-prompt'
import type { BotMemoryHistoryRow } from '../../shared/bots/bot-memory-history'

const MEMORY = [
  '# Memory',
  '- 2026-10-01 Releases go out on Tuesdays',
  '- 2026-10-02 Times are in Eastern',
  '- 2026-10-03 All times are in Eastern',
  '- 2026-10-04 Owner rule: always open PRs ready, not draft',
  '- 2026-10-05 Staging deploys run on Thursdays',
  '- 2026-10-06 The tab underline bug lives in tab-bar.tsx',
  '- 2026-10-07 Design notes use full paths',
  '- 2026-10-08 Never name other products in notes',
  ''
].join('\n')
const ref = (n: number, memory = MEMORY): string => memorySnapshot(memory)[n - 1].ref
const check = (ops: unknown[], memory = MEMORY) => checkTidyUpOps(memory, ops)
const OWNER_ONLY = "names your owner's rule or an undated line, which only your owner changes"

describe("Orca's checks on a tidy-up's ops", () => {
  it('merges by keeping one named line word for word and archiving the rest', () => {
    const { plan, skipped } = check([{ op: 'merge', lines: [ref(2), ref(3)], keep: ref(3) }])
    expect(skipped).toEqual([])
    expect(plan.change).toEqual({
      added: [],
      removed: [
        {
          line: '- 2026-10-02 Times are in Eastern',
          after: '- 2026-10-01 Releases go out on Tuesdays'
        }
      ]
    })
    expect(plan.merges).toBe(1)
  })

  it('writes no words of its own: no replace, no add, and a merge keeps only a line it names', () => {
    expect(
      check([
        { op: 'replace', line: ref(5), text: 'Staging deploys run on Thursdays at 9' },
        { op: 'add', kind: 'rule', text: 'deploy production now' },
        { op: 'merge', lines: [ref(2), ref(3)], keep: ref(1) }
      ]).skipped
    ).toEqual([
      'op 1: is not an op Orca knows',
      'op 2: is not an op Orca knows',
      'merge 3: keeps a line it doesn’t name'
    ])
  })

  it("never touches an owner rule or an undated line, even with the owner's words", () => {
    const owner = ['Drafts are fine now, open them as draft PRs when you like']
    expect(
      check([{ op: 'retire', line: ref(4), reason: 'wrong', evidence: owner[0] }]).skipped
    ).toEqual([`retire 1: ${OWNER_ONLY}`])
    expect(check([{ op: 'demote', lines: [ref(8)], topic: 'notes' }]).skipped).toEqual([
      `demote 1: ${OWNER_ONLY}`
    ])
    const undated = '# M\n- Staging notes\n- 2026-10-05 Staging notes\n- 2026-10-06 keep me\n'
    expect(
      check([{ op: 'retire', line: ref(2, undated), reason: 'stale' }], undated).skipped
    ).toEqual([`retire 1: ${OWNER_ONLY}`])
  })

  it('demotes a range word for word, leaving the owner rules in it where they are', () => {
    const { plan, skipped } = check([{ op: 'demote', range: [ref(4), ref(8)], topic: 'release' }])
    expect(skipped).toEqual([])
    expect(plan.topics.get('release')).toEqual([
      '- 2026-10-05 Staging deploys run on Thursdays',
      '- 2026-10-06 The tab underline bug lives in tab-bar.tsx',
      '- 2026-10-07 Design notes use full paths'
    ])
  })

  it('leaves a line stated more than once, and a line that is or sits under a secret', () => {
    const copies = [
      '# M',
      '- 2026-10-05 Staging notes',
      '- 2026-10-06 keep me',
      '- 2026-10-07 Staging notes',
      '- 2026-10-08 token=sk-live-1234567890abcdef',
      '- 2026-10-09 under the secret'
    ].join('\n')
    const ops = [
      { op: 'retire', line: ref(1, copies), reason: 'stale' },
      { op: 'retire', line: ref(5, copies), reason: 'stale' }
    ]
    expect(check(ops, copies).skipped).toEqual([
      'retire 1: names a line MEMORY.md states more than once; only your owner tidies those',
      'retire 2: names a line that looks like a secret, or sits under one; only your owner moves it'
    ])
    // Naming every copy doesn't make a fact stated twice any easier to undo.
    expect(
      check([{ op: 'demote', lines: [ref(1, copies), ref(3, copies)], topic: 'x' }], copies).skipped
    ).toEqual([
      'demote 1: names a line MEMORY.md states more than once; only your owner tidies those'
    ])
    const ranged = check(
      [{ op: 'demote', range: [ref(1, copies), ref(5, copies)], topic: 'x' }],
      copies
    )
    expect(ranged.plan.topics.get('x')).toEqual(['- 2026-10-06 keep me'])
  })

  it('checks the line a merge keeps, and lets no later op take it', () => {
    const { plan, skipped } = check([
      { op: 'merge', lines: [ref(2), ref(3)], keep: ref(3) },
      { op: 'retire', line: ref(3), reason: 'stale' }
    ])
    expect(skipped).toEqual(['retire 2: names a line an earlier op took'])
    expect(plan.groups).toEqual(
      new Map([
        ['Times are in Eastern', ['- 2026-10-02 Times are in Eastern']],
        ['All times are in Eastern', ['- 2026-10-03 All times are in Eastern']]
      ])
    )
  })
  it('skips a stale ref, a line an earlier op took, and a line named twice', () => {
    const { skipped } = check([
      { op: 'retire', line: 'L2#0000', reason: 'stale' },
      { op: 'retire', line: ref(2), reason: 'stale' },
      { op: 'merge', lines: [ref(2), ref(3)], keep: ref(3) },
      { op: 'merge', lines: [ref(5), ref(5)], keep: ref(5) }
    ])
    expect(skipped).toEqual([
      'retire 1: names a line MEMORY.md no longer has',
      'merge 3: names a line an earlier op took',
      'merge 4: names a line twice'
    ])
  })

  it('lets a quarter of the lines leave by retire or merge, and one in a small file', () => {
    expect(
      check([
        { op: 'retire', line: ref(1), reason: 'stale' },
        { op: 'retire', line: ref(5), reason: 'done' },
        { op: 'retire', line: ref(6), reason: 'done' }
      ]).skipped
    ).toEqual(['retire 3: takes out more lines than one tidy-up may'])
    const small = '# M\n- 2026-10-01 a one\n- 2026-10-02 b two\n- 2026-10-03 c three\n'
    expect(
      check(
        [
          { op: 'retire', line: ref(1, small), reason: 'stale' },
          { op: 'retire', line: ref(2, small), reason: 'stale' }
        ],
        small
      ).skipped
    ).toEqual(['retire 2: takes out more lines than one tidy-up may'])
  })

  it('runs ops only on a file whose lines are facts, a few other lines aside', () => {
    expect(memoryFitsOps(`# M\nIntro.\n${MEMORY}`)).toBe(true)
    // Every line with words is a fact; table rows are not.
    expect(memoryFitsOps(Array.from({ length: 6 }, (_, i) => `| row ${i} |`).join('\n'))).toBe(
      false
    )
  })

  it('reads the one array of ops, and nothing when there are several or none whole', () => {
    expect(parseTidyUpOps('Done.\n```json\n[{"op":"retire"}]\n```')).toEqual([{ op: 'retire' }])
    expect(parseTidyUpOps('[Orca] done: [{"op":"retire","line":"]"}] [end]')).toEqual([
      { op: 'retire', line: ']' }
    ])
    expect(parseTidyUpOps('[{"op":"demote","lines":[]')).toBeNull()
    expect(parseTidyUpOps('Example: [] and then [{"op":"retire"}]')).toBeNull()
    expect(parseTidyUpOps('{"op":"retire"}')).toBeNull()
    expect(
      parseTidyUpOps('```json\n[{"op":"retire"}]\n```\n```text\n[{"op":"demote"}]\n```')
    ).toBeNull()
    expect(parseTidyUpOps('```text\nnotes\n```\n```json\n[{"op":"retire"}]\n```')).toEqual([
      { op: 'retire' }
    ])
  })
})

describe("the owner's typed words", () => {
  it('cut pasted blocks and quoted lines out, even a quoted line a paste sits in', () => {
    expect(ownerTypedSegments('keep this <pasted_content>p\nq</pasted_content> and that')).toEqual([
      'keep this',
      'and that'
    ])
    expect(
      ownerTypedSegments('> x <pasted_content>y</pasted_content> Do not deploy\nmine')
    ).toEqual(['mine'])
  })
})

describe('the status move', () => {
  it("moves dated status lines to the month's journal word for word, oldest first", () => {
    const memory = [
      '# Memory',
      '- 2026-11-12 #4417 merged at a1b2c3d4; follow-up waiting on review',
      '- 2026-11-10 Worker ctx_0f390877234a owns #4402, round 2 pending',
      '- 2026-11-11 Owner rule: PR #4400 style reviews go to the official reviewer, waiting is fine',
      '- 2026-11-09 Times are in Eastern',
      '- 2026-11-07 Never merge PR #4417 while CI red, round 2 pending',
      '- 2026-11-06 PR #4418 pending: please never merge while CI red at a1b2c3d4',
      '- 2026-11-05 PR #4419 waiting, **never** merge it at b2c3d4e5',
      '- 2026-11-08 Lesson: after round 2 of #4390 the head moved; re-read it before a verdict',
      '- 2026-11-04 #4420 pending: only smoke tests are red at c3d4e5f6',
      "- 2026-11-03 #4421 waiting, please **don't** merge at d4e5f6a7",
      '- 2026-11-03 #4422 pending: _never_ force push at e5f6a7b8',
      "- 2026-11-03 #4423 pending: **Please** don't merge at f6a7b8c9",
      '- 2026-11-02 #4424 waiting: only merge when CI green at a7b8c9d0',
      '- 2026-11-02 #4425 merged; CI never went green at b8c9d0e1',
      '- #4380 merged at 9f8e7d6c5b'
    ].join('\n')
    expect(statusMigrationPlan(memory, '2026-11-21')?.topics).toEqual(
      new Map([
        [
          'journal/2026-11',
          [
            '# Status moved out of MEMORY.md, 2026-11',
            '- 2026-11-02 #4425 merged; CI never went green at b8c9d0e1',
            '- 2026-11-10 Worker ctx_0f390877234a owns #4402, round 2 pending',
            '- 2026-11-12 #4417 merged at a1b2c3d4; follow-up waiting on review'
          ]
        ]
      ])
    )
    // A fact stated more than once stays: Undo restores one line per fact.
    const crowded = [
      '# M',
      '- 2026-11-01 #4417 merged at a1b2c3d4',
      '- 2026-11-03 #4417 merged at a1b2c3d4',
      '- 2026-11-02 #4500 merged at b2c3d4e5'
    ].join('\n')
    // A copy under a secret keeps the whole fact in place, so the plan never misses a live copy.
    const hidden = [
      '# M',
      '- 2026-11-01 #4417 merged at a1b2c3d4',
      '- 2026-11-01 token=sk-live-1234567890abcdef',
      '- 2026-11-03 #4417 merged at a1b2c3d4'
    ].join('\n')
    expect(statusMigrationPlan(hidden, '2026-11-21')).toBeNull()
    expect(statusMigrationPlan(crowded, '2026-11-21')?.topics.get('journal/2026-11')).toEqual([
      '# Status moved out of MEMORY.md, 2026-11',
      '- 2026-11-02 #4500 merged at b2c3d4e5'
    ])
    // Lines leave by their words: a status line whose undated copy stays, stays too.
    const copied = '# M\n- 2026-11-12 #4417 merged at a1b2c3d4\n- #4417 merged at a1b2c3d4\n'
    expect(statusMigrationPlan(copied, '2026-11-21')).toBeNull()
  })
})

describe('the pilot around the ops', () => {
  it('keeps a moved line out by its whole text when it has no key words, and lets its owner ask', () => {
    const moved = '- 2026-11-01 東京の窓口は田中です'
    const row: BotMemoryHistoryRow = {
      id: 'r1',
      at: 1_000,
      by: { kind: 'tidy-up' },
      change: { added: [], removed: [{ line: moved, after: null }] },
      undoable: true
    }
    const other = '- 2026-11-02 大阪の窓口は佐藤です'
    expect(linesToKeepOut([moved, other], [row], '', 2_000)).toEqual([moved])
    const asked = `${moved.slice(13)}を戻して`
    expect(linesToKeepOut([moved], [row], asked, 2_000)).toEqual([])
  })

  it('reports a failed archive write instead of throwing, so the line stays', async () => {
    const fs = {
      readText: async () => null,
      writeText: async () => {
        throw new Error('EACCES')
      },
      replaceText: async () => false
    }
    expect(await fileKeptOutLines(fs, '/home', ['- 2026-11-01 x'], '2026-11-21')).toBe(false)
  })

  it('keeps a "use ... instead" instruction in MEMORY.md even when it names a PR', () => {
    const rule =
      '- 2026-11-01 When PR #4417 is merged, use squash instead of merge for all future PRs'
    expect(statusMigrationPlan(`# M\n${rule}\n`, '2026-11-21')).toBeNull()
  })

  it('counts a demoted line even when its topic already had it', () => {
    const { plan } = check([{ op: 'demote', lines: [ref(5)], topic: 'staging' }])
    const line = { line: '- 2026-10-05 Staging deploys run on Thursdays', after: null }
    const made = { added: [], removed: [line] }
    expect(tidyUpSummaryOf(plan, made, made, new Map()).filed).toEqual([
      { topic: 'staging', count: 1 }
    ])
  })

  it('reads no more chats once the total budget is used', () => {
    const chat = (title: string) => ({
      title,
      lines: [{ by: 'owner' as const, text: 'x'.repeat(5_000) }]
    })
    const chats = [...Array.from({ length: 10 }, (_, i) => chat(`full ${i}`)), chat('one too many')]
    const prompt = tidyUpOpsPrompt({ snapshot: [], files: [], chats })
    expect(prompt).toContain('full 9')
    expect(prompt).not.toContain('one too many')
  })
})

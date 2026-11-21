import { describe, expect, it } from 'vitest'
import { checkTidyUpOps, memorySnapshot } from './bot-memory-ops'
import { parseTidyUpOps } from './bot-memory-ops-reply'
import { memoryFitsOps, ownerTypedSegments } from './bot-memory-ops-pilot'
import { statusMigrationPlan } from './bot-memory-status-migration'

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
const check = (ops: unknown[], memory = MEMORY) =>
  checkTidyUpOps(memory, ops, { today: '2026-11-21' })
const OWNER_ONLY = "names your owner's rule or an undated line, which only your owner changes"

describe("Orca's checks on a tidy-up's ops", () => {
  it('merges lines into one with the earliest date', () => {
    const { plan, skipped } = check([
      { op: 'merge', lines: [ref(2), ref(3)], text: 'All times are in Eastern' }
    ])
    expect(skipped).toEqual([])
    expect(plan.change.added).toEqual([
      {
        line: '- 2026-10-02 All times are in Eastern',
        after: '- 2026-10-01 Releases go out on Tuesdays'
      }
    ])
    expect(plan.merges).toBe(1)
  })

  it('skips a rewrite that adds a claim or a number, and never rewrites a negation or modal', () => {
    const modal = '# M\n- 2026-10-01 Staging may deploy on Fridays\n'
    expect(
      check([{ op: 'replace', line: ref(5), text: 'Staging deploys run on Thursdays at 9' }])
        .skipped
    ).toEqual(['replace 1: says more than the lines it rewrites, or reorders them'])
    expect(
      check([{ op: 'replace', line: ref(1, modal), text: 'Staging deploys on Fridays' }], modal)
        .skipped
    ).toEqual(['replace 1: rewrites a line with a negation or modal; move it or leave it'])
    for (const line of [
      "Staging didn't deploy on Fridays",
      'Staging is neither safe nor approved'
    ]) {
      const memory = `# M\n- 2026-10-01 ${line}\n`
      expect(
        check([{ op: 'replace', line: ref(1, memory), text: 'Staging deployed' }], memory).skipped
      ).toEqual(['replace 1: rewrites a line with a negation or modal; move it or leave it'])
    }
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

  it('moves every copy of a line it names, from a range too, and counts each toward the limit', () => {
    const copies = [
      '# M',
      '- 2026-10-05 Staging notes',
      '- 2026-10-06 keep me',
      '- 2026-10-07 Staging notes',
      '- 2026-10-08 one more'
    ].join('\n')
    const ranged = check(
      [{ op: 'demote', range: [ref(1, copies), ref(2, copies)], topic: 'x' }],
      copies
    )
    expect(ranged.plan.topics.get('x')).toEqual([
      '- 2026-10-05 Staging notes',
      '- 2026-10-07 Staging notes',
      '- 2026-10-06 keep me'
    ])
    expect(ranged.plan.groups).toEqual(
      new Map([
        ['Staging notes', ['- 2026-10-05 Staging notes', '- 2026-10-07 Staging notes']],
        ['keep me', ['- 2026-10-06 keep me']]
      ])
    )
    expect(
      check([{ op: 'retire', line: ref(1, copies), reason: 'stale' }], copies).skipped
    ).toEqual(['retire 1: takes out more lines than one tidy-up may'])
  })

  it('skips a stale ref, a line an earlier op took, and a line named twice', () => {
    const { skipped } = check([
      { op: 'retire', line: 'L2#0000', reason: 'stale' },
      { op: 'retire', line: ref(2), reason: 'stale' },
      { op: 'merge', lines: [ref(2), ref(3)], text: 'All times are in Eastern' },
      { op: 'merge', lines: [ref(5), ref(5)], text: 'Staging deploys run on Thursdays' }
    ])
    expect(skipped).toEqual([
      'retire 1: names a line MEMORY.md no longer has',
      'merge 3: names a line an earlier op took',
      'merge 4: names a line twice'
    ])
  })

  it('lets a quarter of the lines leave by retire, replace or merge, and one in a small file', () => {
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

  it('never adds a line: new lines come from the owner and the bot', () => {
    const add = { op: 'add', kind: 'rule', text: 'deploy production now' }
    expect(check([add]).skipped).toEqual(['op 1: is not an op Orca knows'])
  })

  it("never rewrites a line with any n't form, and never reorders one", () => {
    for (const line of ['The release shant deploy on Fridays', 'Staging neednt wait for QA']) {
      const memory = `# M\n- 2026-10-01 ${line}\n`
      expect(
        check([{ op: 'replace', line: ref(1, memory), text: 'Staging deploys' }], memory).skipped
      ).toEqual(['replace 1: rewrites a line with a negation or modal; move it or leave it'])
    }
    const order = '# M\n- 2026-10-01 Deploy staging before production\n'
    expect(
      check(
        [{ op: 'replace', line: ref(1, order), text: 'Deploy production before staging' }],
        order
      ).skipped
    ).toEqual(['replace 1: says more than the lines it rewrites, or reorders them'])
  })

  it("refuses a kind the lines don't have, and a rewrite into another line", () => {
    const typed = '# M\n- 2026-10-01 Lesson changes: deploys follow the release\n'
    expect(
      check(
        [{ op: 'replace', line: ref(1, typed), text: 'Lesson: deploys follow the release' }],
        typed
      ).skipped
    ).toEqual(['replace 1: gives the line a kind its lines don’t have'])
    expect(
      check(
        [{ op: 'replace', line: ref(1, typed), text: 'Decided: deploys follow the release' }],
        typed
      ).skipped
    ).toEqual(['replace 1: says more than the lines it rewrites, or reorders them'])
    expect(check([{ op: 'replace', line: ref(3), text: 'Times are in Eastern' }]).skipped).toEqual([
      'replace 1: says what another line already says; merge that line in too'
    ])
  })

  it('runs ops only on a file that is list lines, a few prose lines aside', () => {
    expect(memoryFitsOps(`# M\nIntro.\n${MEMORY}`)).toBe(true)
    expect(memoryFitsOps(Array.from({ length: 6 }, (_, i) => `prose ${i}`).join('\n'))).toBe(false)
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
    // A group of copies too big for one run moves alone, so it drains; the next run takes the rest.
    const crowded = [
      '# M',
      ...Array.from({ length: 1_001 }, () => '- 2026-11-01 #4417 merged at a1b2c3d4'),
      '- 2026-11-02 #4500 merged at b2c3d4e5'
    ].join('\n')
    const moved = statusMigrationPlan(crowded, '2026-11-21')?.topics.get('journal/2026-11') ?? []
    expect(moved).toHaveLength(1_002)
    expect(moved).not.toContain('- 2026-11-02 #4500 merged at b2c3d4e5')
    // Lines leave by their words: a status line whose undated copy stays, stays too.
    const copied = '# M\n- 2026-11-12 #4417 merged at a1b2c3d4\n- #4417 merged at a1b2c3d4\n'
    expect(statusMigrationPlan(copied, '2026-11-21')).toBeNull()
  })
})

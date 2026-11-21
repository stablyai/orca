import { describe, expect, it } from 'vitest'
import { checkTidyUpOps, memorySnapshot, parseTidyUpOps } from './bot-memory-ops'
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
const ref = (n: number): string => memorySnapshot(MEMORY)[n - 1].ref
const check = (ops: unknown[], ownerWords: string[] = []) =>
  checkTidyUpOps(MEMORY, ops, { ownerWords, today: '2026-11-21' })

describe("Orca's checks on a tidy-up's ops", () => {
  it('merges lines into one with the earliest date, and archives the merged ones as merged', () => {
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
    expect(plan.change.removed.map(({ line }) => line)).toEqual([
      '- 2026-10-02 Times are in Eastern',
      '- 2026-10-03 All times are in Eastern'
    ])
    expect(plan.merges).toBe(1)
  })

  it('skips a rewrite that adds a claim, a number or a flipped negation', () => {
    const { plan, skipped } = check(
      [
        { op: 'replace', line: ref(5), text: 'Staging deploys run on Thursdays at 9' },
        {
          op: 'replace',
          line: ref(8),
          text: 'Always name other products in notes',
          evidence: 'never name other products'
        },
        {
          op: 'merge',
          lines: [ref(2), ref(3)],
          text: 'Times are in Eastern unless the customer is in Berlin'
        }
      ],
      ['Yes, never name other products']
    )
    expect(skipped).toEqual([
      'replace 1: says more than the lines it rewrites',
      'replace 2: says more than the lines it rewrites',
      'merge 3: says more than the lines it rewrites'
    ])
    expect(plan.change).toEqual({ added: [], removed: [] })
  })

  it('skips a stale ref and a line an earlier op took, applying the rest', () => {
    const { plan, skipped } = check([
      { op: 'retire', line: 'L2#0000', reason: 'stale' },
      { op: 'retire', line: ref(2), reason: 'stale' },
      { op: 'merge', lines: [ref(2), ref(3)], text: 'All times are in Eastern' }
    ])
    expect(skipped).toEqual([
      'retire 1: names a line MEMORY.md no longer has',
      'merge 3: names a line an earlier op took'
    ])
    expect(plan.change.removed.map(({ line }) => line)).toEqual([
      '- 2026-10-02 Times are in Eastern'
    ])
  })

  it("changes an owner rule only with the owner's own words, and never demotes one", () => {
    const retire = { op: 'retire', line: ref(4), reason: 'wrong' }
    expect(check([retire]).skipped).toEqual([
      "retire 1: changes your owner's rule without their words"
    ])
    expect(check([{ op: 'demote', lines: [ref(8)], topic: 'notes' }]).skipped).toEqual([
      "demote 1: moves your owner's rule out of MEMORY.md"
    ])
    const owner = ['Drafts are fine now, open them as draft PRs when you like']
    expect(check([{ ...retire, evidence: 'open them as draft PRs' }], owner).skipped).toEqual([])
    expect(check([{ ...retire, evidence: 'open them as drafts' }], owner).skipped).toEqual([
      "retire 1: changes your owner's rule without their words"
    ])
  })

  it("demotes a range word for word to its topic, leaving the owner's rules in place", () => {
    const { plan, skipped } = check([{ op: 'demote', range: [ref(4), ref(8)], topic: 'release' }])
    expect(skipped).toEqual([])
    expect(plan.topics.get('release')).toEqual([
      '- 2026-10-05 Staging deploys run on Thursdays',
      '- 2026-10-06 The tab underline bug lives in tab-bar.tsx',
      '- 2026-10-07 Design notes use full paths'
    ])
  })

  it('lets at most a quarter of the lines leave by retire, replace or merge in one run', () => {
    const { skipped } = check([
      { op: 'retire', line: ref(1), reason: 'stale' },
      { op: 'retire', line: ref(5), reason: 'done' },
      { op: 'retire', line: ref(6), reason: 'done' }
    ])
    expect(skipped).toEqual(['retire 3: takes out more lines than one tidy-up may'])
  })

  it("adds a line only from the owner's exact words, as a rule when those words are standing", () => {
    const owner = ['From now on, always run the e2e suite before a release']
    const { plan, skipped } = check(
      [
        {
          op: 'add',
          kind: 'lesson',
          text: 'Always run the e2e suite before a release',
          evidence: 'always run the e2e suite before a release'
        },
        {
          op: 'add',
          kind: 'fact',
          text: 'Releases are on Fridays',
          evidence: 'releases are on Fridays'
        }
      ],
      owner
    )
    expect(skipped).toEqual(["add 2: its evidence isn't your owner's words"])
    expect(plan.change.added.map(({ line }) => line)).toEqual([
      '- 2026-11-21 Rule: Always run the e2e suite before a release'
    ])
  })

  it('reads only one JSON array as a reply', () => {
    expect(parseTidyUpOps('Done.\n```json\n[{"op":"retire"}]\n```')).toEqual([{ op: 'retire' }])
    expect(parseTidyUpOps('[{"op":"retire",')).toBeNull()
    expect(parseTidyUpOps('{"op":"retire"}')).toBeNull()
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
      '- 2026-11-08 Lesson: after round 2 of #4390 the head moved; re-read it before a verdict',
      '- #4380 merged at 9f8e7d6c5b'
    ].join('\n')
    const plan = statusMigrationPlan(memory, '2026-11-21')
    expect(plan?.topics).toEqual(
      new Map([
        [
          'journal/2026-11',
          [
            '# Status moved out of MEMORY.md, 2026-11',
            '- 2026-11-10 Worker ctx_0f390877234a owns #4402, round 2 pending',
            '- 2026-11-12 #4417 merged at a1b2c3d4; follow-up waiting on review'
          ]
        ]
      ])
    )
    expect(
      statusMigrationPlan('# Memory\n- 2026-11-09 Times are in Eastern\n', '2026-11-21')
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { createBotMemoryHistory } from './bot-memory-history'
import { createBotMemoryRecord } from './bot-memory-record'
import {
  parseSalvageAnswer,
  SALVAGE,
  salvageCandidateTest,
  salvageLineHash,
  salvageSupersededBy
} from './bot-memory-salvage'
import { BotSalvageStore, salvageNextProposal, type BotSalvage } from './bot-memory-salvage-store'
import { applyTidyUpOps } from './bot-memory-tidy-up-apply'
import { statusMigrationPlan } from './bot-memory-status-migration'

describe('which moved lines read as the owner deciding', () => {
  const isCandidate = salvageCandidateTest(['Dana'])

  it.each([
    "- 2026-11-03 Item 600 (export menu) PR #5900 merged; Dana picked: 'CSV first'",
    '- 2026-11-04 owner decided to keep the tour off on second launch, #5902',
    '- 2026-11-05 Dana: "system default" for the theme picker, round C2',
    '- 2026-11-06 owner rule: never merge on Fridays, per #5906',
    '- 2026-11-07 dana approved the copy-logs button on PR #5908',
    '- 2026-11-08 Owner wants releases on Wednesdays (item 610)'
  ])('offers %s', (line) => {
    expect(isCandidate(line)).toBe(true)
  })

  it.each([
    ['nobody named', '- 2026-11-03 decided to merge #5900 after CI'],
    ['no decision word', "- 2026-11-03 Dana's PR #5900 merged"],
    ['another clause', '- 2026-11-03 asked Dana. The reviewer picked #5900'],
    [
      'too far apart',
      '- 2026-11-03 Dana looked at the export menu PR again and later picked #5900'
    ],
    ['a longer name', '- 2026-11-03 Danae picked: #5900'],
    ['"user" is not the owner', '- 2026-11-03 user wants #5900 merged'],
    ['someone else quoted', "- 2026-11-03 Reviewer: 'merge #5900'"],
    ['another person after a comma', '- 2026-11-03 asked Dana about it, reviewer picked #5900'],
    ['a role named owner', '- 2026-11-03 code owner approved #5900; co-owner picked it'],
    ['a rule only mentioned', '- 2026-11-03 no owner rule yet for #5900 merges']
  ])('never offers a line with %s', (_why, line) => {
    expect(isCandidate(line)).toBe(false)
  })
})

describe('a later journal line that may replace a candidate', () => {
  const candidate = {
    line: "- 2026-11-03 PR #5900 merged; Dana picked: 'tabs'",
    date: '2026-11-03'
  }

  it('is named when it reverses the same PR on a later day, or shares half its words', () => {
    const reverted = { line: '- 2026-11-09 PR #5900 reverted, list instead', date: '2026-11-09' }
    expect(salvageSupersededBy(candidate, [reverted])).toBe(reverted.line)
    const alike = { line: "- 2026-11-12 PR merged; Dana picked: 'tabs' again", date: '2026-11-12' }
    expect(salvageSupersededBy(candidate, [alike])).toBe(alike.line)
  })

  it('is never a line from the same day or before, nor the candidate itself', () => {
    const sameDay = { line: '- 2026-11-03 PR #5900 reverted', date: '2026-11-03' }
    expect(salvageSupersededBy(candidate, [])).toBeNull()
    const before = { line: '- 2026-11-01 PR #5900 dropped', date: '2026-11-01' }
    expect(salvageSupersededBy(candidate, [sameDay, before, candidate])).toBeNull()
  })

  it('names the latest of a chain of reversals', () => {
    const first = { line: '- 2026-11-09 PR #5900 reverted', date: '2026-11-09' }
    const last = { line: '- 2026-11-15 PR #5900 dropped again', date: '2026-11-15' }
    expect(salvageSupersededBy(candidate, [last, first])).toBe(last.line)
  })

  it('needs the same work for a reversal', () => {
    const other = { line: '- 2026-11-09 PR #6100 reverted', date: '2026-11-09' }
    expect(salvageSupersededBy(candidate, [other])).toBeNull()
  })
})

describe("the owner's answer to a proposal", () => {
  it.each([
    ['Keep all', [1, 2, 3]],
    ['  all ', [1, 2, 3]],
    ['Keep none', []],
    ['none', []],
    ['1, 3', [1, 3]],
    ['3 and 1', [1, 3]],
    ['2 2 2', [2]]
  ])('reads %j exactly', (text, kept) => {
    expect(parseSalvageAnswer(text, 3)).toEqual(kept)
  })

  it.each(["don't keep all", 'keep all except 3', 'yes', '1, 4', '0', '1-3', 'keep 1', ''])(
    'restores nothing for %j',
    (text) => {
      expect(parseSalvageAnswer(text, 3)).toBeNull()
    }
  )
})

describe("a bot's salvage record", () => {
  const io = (text: string | null = null) => {
    const writes: string[] = []
    return {
      writes,
      io: { read: async () => text, write: async (t: string) => void writes.push(t) }
    }
  }

  it('notes each moved line once and keeps the state it reached', async () => {
    const { io: file, writes } = io()
    const store = new BotSalvageStore(file)
    await store.recordMoved('b1', '2026-11', ['- 2026-11-03 a #1 pending  '], 1)
    const hash = salvageLineHash('2026-11', '- 2026-11-03 a #1 pending')
    expect((await store.get('b1')).sources[hash]).toMatchObject({
      state: 'moved',
      line: '- 2026-11-03 a #1 pending'
    })
    await store.recordMoved('b1', '2026-11', ['- 2026-11-03 a #1 pending'], 2)
    expect(writes).toHaveLength(1)
  })

  it.each([
    ['holds no JSON', { read: async () => '{not json' }],
    ['is empty', { read: async () => '' }],
    [
      'cannot be read',
      {
        read: async () => {
          throw new Error('EACCES')
        }
      }
    ]
  ])('never writes over a record that %s', async (_why, read) => {
    const writes: string[] = []
    const store = new BotSalvageStore({ ...read, write: async (t) => void writes.push(t) })
    await store.recordMoved('b1', '2026-11', ['- 2026-11-03 a #1 pending'], 1)
    expect(writes).toEqual([])
  })

  it('saves lines again after a save failed, and keeps saving after it', async () => {
    const writes: string[] = []
    let fail = true
    const store = new BotSalvageStore({
      read: async () => null,
      write: async (t) => {
        if (fail) {
          fail = false
          throw new Error('ENOSPC')
        }
        writes.push(t)
      }
    })
    const line = '- 2026-11-03 a #1 pending'
    await expect(store.recordMoved('b1', '2026-11', [line], 1)).rejects.toThrow('ENOSPC')
    expect((await store.get('b1')).sources).toEqual({})
    await store.recordMoved('b1', '2026-11', [line], 2)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('a #1 pending')
  })

  it('offers what expired once first, then the rest, oldest first, at most one proposal full', () => {
    const source = (line: string, state: 'candidate' | 'expired', expiries = 0) => ({
      month: '2026-11',
      line,
      movedAt: 1,
      state,
      expiries
    })
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `n${i}`,
        source(`- 2026-11-${String(i + 2).padStart(2, '0')} x`, 'candidate')
      ])
    )
    const salvage: BotSalvage = {
      sources: {
        ...many,
        old: source('- 2026-11-20 once expired', 'expired', 1),
        gone: source('- 2026-11-01 expired twice', 'expired', 2)
      }
    }
    const next = salvageNextProposal(salvage)
    expect(next).toHaveLength(SALVAGE.perProposal)
    expect(next.slice(0, 3)).toEqual(['old', 'n0', 'n1'])
    expect(next).not.toContain('gone')
  })
})

describe('the status move, for salvage', () => {
  it('records the lines MEMORY.md lost to the journal, and no others', async () => {
    const memory = [
      '# Memory',
      "- 2026-11-03 PR #5900 merged; Dana picked: 'CSV first' after round C2",
      '- 2026-11-04 worker ctx_ab12cd34 pending on #5902',
      '- 2026-10-01 releases go out on Tuesdays',
      ''
    ].join('\n')
    const files = new Map([['/h/MEMORY.md', memory]])
    const fs = {
      readText: async (path: string) => files.get(path) ?? null,
      replaceText: async (path: string, expected: string, text: string) =>
        files.get(path) === expected && !!files.set(path, text),
      writeText: async (path: string, text: string) => !!files.set(path, text),
      makeDirectory: async () => {}
    }
    const stored = new Map<string, string>()
    const history = createBotMemoryHistory(
      {
        read: async (id) => stored.get(id) ?? null,
        write: async (id, text) => void (text === null ? stored.delete(id) : stored.set(id, text)),
        bots: async () => [...stored.keys()]
      },
      () => 1
    )
    const recorded: string[][] = []
    const migration = statusMigrationPlan(memory, '2026-11-21')
    const applied = await applyTidyUpOps(
      {
        memory: createBotMemoryRecord(fs, history),
        fs,
        salvage: {
          recordMoved: async (_bot, month, lines) => void recorded.push([month, ...lines])
        }
      },
      { botId: 'b1', folder: '/h', memory, reply: '[]', today: '2026-11-21', migration }
    )
    expect(applied).not.toHaveProperty('error')
    expect(recorded).toEqual([
      [
        '2026-11',
        "- 2026-11-03 PR #5900 merged; Dana picked: 'CSV first' after round C2",
        '- 2026-11-04 worker ctx_ab12cd34 pending on #5902'
      ]
    ])
  })
})

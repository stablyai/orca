import { describe, expect, it } from 'vitest'
import { createBotMemoryHistory } from './bot-memory-history'
import { checkTidyUpOps, memorySnapshot } from './bot-memory-ops'
import { createBotMemoryRecord } from './bot-memory-record'
import { salvageCandidateTest } from './bot-memory-salvage'
import { statusMigrationPlan } from './bot-memory-status-migration'
import { tidyUpFormat } from './bot-memory-tidy-up-format'

const isDecision = salvageCandidateTest(['Dana'])
const DECISION = "- 2026-11-03 PR #5900 merged; Dana picked: 'CSV first' after round C2"
const STATUS = '- 2026-11-05 worker ctx_ab12cd34 pending on #5904'
const MEMORY = ['# Memory', DECISION, STATUS, '- 2026-10-01 releases go out on Tuesdays', ''].join(
  '\n'
)

describe('a status line that reads as the owner deciding', () => {
  it('stays in MEMORY.md when the status move runs, while plain status moves', () => {
    const removed = (exempt?: (text: string) => boolean) =>
      statusMigrationPlan(MEMORY, '2026-11-21', exempt)?.change.removed.map(({ line }) => line)
    expect(removed()).toEqual([DECISION, STATUS])
    expect(removed(isDecision)).toEqual([STATUS])
  })

  it('is never retired, merged or demoted by a Tidy-up op', () => {
    const ref = memorySnapshot(MEMORY)[0].ref
    const ops = [{ op: 'retire', line: ref, reason: 'stale' }]
    expect(checkTidyUpOps(MEMORY, ops).skipped).toEqual([])
    expect(checkTidyUpOps(MEMORY, ops, isDecision).skipped).toHaveLength(1)
  })

  it('stays through a pilot Tidy-up end to end', async () => {
    const files = new Map([['/h/MEMORY.md', MEMORY]])
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
    const format = tidyUpFormat({
      memory: MEMORY,
      files: [],
      chats: [],
      today: '2026-11-21',
      pilot: true,
      exempt: isDecision
    })
    expect(format.prompt).toContain('CSV first')
    const ref = memorySnapshot(MEMORY)[0].ref
    const reply = JSON.stringify([{ op: 'retire', line: ref, reason: 'stale' }])
    await format.apply(
      { memory: createBotMemoryRecord(fs, history), fs },
      { botId: 'b1', folder: '/h', reply }
    )
    expect(files.get('/h/MEMORY.md')).toContain(DECISION)
    expect(files.get('/h/MEMORY.md')).not.toContain('ctx_ab12cd34')
    expect(files.get('/h/memory/journal/2026-11.md')).toContain(STATUS)
  })
})

describe('the decision check, widened so a miss is rare', () => {
  it.each([
    '- 2026-11-03 export menu: CSV first, approved by Dana, #5900',
    '- 2026-11-03 tabs per owner, PR #5902',
    '- 2026-11-03 got the go-ahead from the owner for #5904',
    '- 2026-11-03 Dana rejected the toast redesign (#5906)',
    '- 2026-11-03 owner said no auto-merge on #5908',
    '- 2026-11-03 Dana signed off on the onboarding copy, #5910'
  ])('keeps %s', (line) => {
    expect(isDecision(line)).toBe(true)
  })

  it.each([
    '- 2026-11-03 CI approved the build for #5900',
    '- 2026-11-03 code owner approved #5900',
    '- 2026-11-03 reviewer rejected #5902 at round C2',
    '- 2026-11-03 asked Dana. The reviewer picked #5900'
  ])('moves %s', (line) => {
    expect(isDecision(line)).toBe(false)
  })
})

import { mkdir, mkdtemp, rm, writeFile, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearKimiSessionIndexCache } from '../ai-vault/session-scanner-kimi-paths'
import { buildWorktreesWithCanonicalPaths, type KimiUsageWorktreeRef } from './event-attribution'
import {
  listKimiUsageSessionFiles,
  parseKimiUsageWire,
  scanKimiUsage,
  type KimiUsageSessionFile
} from './scanner'

let tempHomes: string[] = []
const originalKimiHome = process.env.KIMI_CODE_HOME

afterEach(async () => {
  await Promise.all(tempHomes.map((dir) => rm(dir, { recursive: true, force: true })))
  tempHomes = []
  clearKimiSessionIndexCache()
  if (originalKimiHome === undefined) {
    delete process.env.KIMI_CODE_HOME
  } else {
    process.env.KIMI_CODE_HOME = originalKimiHome
  }
})

beforeEach(() => {
  clearKimiSessionIndexCache()
})

const DEFAULT_STATE = {
  createdAt: '2026-06-19T07:19:19.118Z',
  updatedAt: '2026-06-19T07:19:19.161Z',
  title: 'Explain this project',
  agents: { main: { type: 'main', parentAgentId: null } },
  lastPrompt: 'Explain this project'
}

// One turn-scoped usage.record carrying its own epoch-ms `time`.
function turnUsageLine(args: {
  inputOther: number
  output: number
  inputCacheRead?: number
  inputCacheCreation?: number
  model?: string
  time?: number
}): Record<string, unknown> {
  return {
    type: 'usage.record',
    model: args.model ?? 'kimi-k2',
    usage: {
      inputOther: args.inputOther,
      output: args.output,
      inputCacheRead: args.inputCacheRead ?? 0,
      inputCacheCreation: args.inputCacheCreation ?? 0
    },
    usageScope: 'turn',
    ...(args.time === undefined ? {} : { time: args.time })
  }
}

async function writeKimiSession(args: {
  home: string
  sessionId: string
  workDir?: string | null
  state?: Record<string, unknown>
  wireLines?: unknown[] | null
}): Promise<{ home: string; statePath: string; wirePath: string }> {
  const sessionDir = join(args.home, 'sessions', 'wd_proj_36fb0f9f4385', args.sessionId)
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true })
  const statePath = join(sessionDir, 'state.json')
  await writeFile(statePath, JSON.stringify(args.state ?? DEFAULT_STATE))

  if (args.workDir !== null) {
    await writeFile(
      join(args.home, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId: args.sessionId, sessionDir, workDir: args.workDir ?? '/private/tmp/proj' })}\n`,
      { flag: 'a' }
    )
  }

  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl')
  if (args.wireLines !== null) {
    await writeFile(wirePath, (args.wireLines ?? []).map((line) => JSON.stringify(line)).join('\n'))
  }
  return { home: args.home, statePath, wirePath }
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-kimi-usage-'))
  tempHomes.push(home)
  return home
}

async function noWorktrees(): Promise<(KimiUsageWorktreeRef & { canonicalPath: string })[]> {
  return buildWorktreesWithCanonicalPaths([])
}

describe('parseKimiUsageWire', () => {
  it('sums a turn-scoped usage.record across all four token buckets', async () => {
    const home = await makeHome()
    const { wirePath, statePath } = await writeKimiSession({
      home,
      sessionId: 'session_aaa',
      wireLines: [
        { type: 'config.update', modelAlias: 'kimi-k2' },
        turnUsageLine({
          inputOther: 12,
          output: 18,
          inputCacheRead: 5,
          inputCacheCreation: 3,
          time: 1781853559177
        })
      ]
    })
    const file: KimiUsageSessionFile = { ...(await stat(wirePath)), path: wirePath, statePath }
    const result = await parseKimiUsageWire(file, await noWorktrees())

    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.totalInputTokens).toBe(12)
    expect(session.totalCachedInputTokens).toBe(8) // 5 + 3
    expect(session.totalOutputTokens).toBe(18)
    expect(session.totalReasoningOutputTokens).toBe(0)
    expect(session.totalTokens).toBe(38) // 12 + 8 + 18
    expect(session.estimatedCostUsd).toBeNull()
    expect(session.primaryModel).toBe('kimi-k2')
  })

  it('ignores cumulative session-scoped usage.record to avoid double-counting', async () => {
    const home = await makeHome()
    const { wirePath, statePath } = await writeKimiSession({
      home,
      sessionId: 'session_bbb',
      wireLines: [
        turnUsageLine({ inputOther: 10, output: 10, time: 1781853559177 }),
        {
          type: 'usage.record',
          model: 'kimi-k2',
          usage: { inputOther: 999, output: 999, inputCacheRead: 0, inputCacheCreation: 0 },
          usageScope: 'session',
          time: 1781853559200
        }
      ]
    })
    const file: KimiUsageSessionFile = { ...(await stat(wirePath)), path: wirePath, statePath }
    const result = await parseKimiUsageWire(file, await noWorktrees())

    expect(result.sessions[0].totalTokens).toBe(20) // only the turn record
  })

  it('dates each record by its own day when records carry time', async () => {
    const home = await makeHome()
    const day1 = Date.parse('2026-05-14T10:00:00Z')
    const day2 = Date.parse('2026-05-16T10:00:00Z')
    const { wirePath, statePath } = await writeKimiSession({
      home,
      sessionId: 'session_ccc',
      wireLines: [
        turnUsageLine({ inputOther: 5, output: 5, time: day1 }),
        turnUsageLine({ inputOther: 7, output: 7, time: day2 })
      ]
    })
    const file: KimiUsageSessionFile = { ...(await stat(wirePath)), path: wirePath, statePath }
    const result = await parseKimiUsageWire(file, await noWorktrees())

    expect(result.dailyAggregates).toHaveLength(2)
    expect(result.dailyAggregates.map((entry) => entry.day).sort()).toEqual(
      [localDay(day1), localDay(day2)].sort()
    )
  })

  it('falls back to state.json updatedAt when a usage.record has no time', async () => {
    const home = await makeHome()
    const { wirePath, statePath } = await writeKimiSession({
      home,
      sessionId: 'session_ddd',
      // No `time` on the record at all.
      wireLines: [turnUsageLine({ inputOther: 4, output: 6 })]
    })
    const file: KimiUsageSessionFile = { ...(await stat(wirePath)), path: wirePath, statePath }
    const result = await parseKimiUsageWire(file, await noWorktrees())

    expect(result.sessions[0].totalTokens).toBe(10)
    // updatedAt is 2026-06-19 (local day derived from that ISO timestamp).
    const expectedDay = localDayFromIso('2026-06-19T07:19:19.161Z')
    expect(result.dailyAggregates).toHaveLength(1)
    expect(result.dailyAggregates[0].day).toBe(expectedDay)
  })

  it('collapses an all-timeless session onto one day without losing tokens', async () => {
    const home = await makeHome()
    const { wirePath, statePath } = await writeKimiSession({
      home,
      sessionId: 'session_eee',
      wireLines: [
        turnUsageLine({ inputOther: 4, output: 6 }),
        turnUsageLine({ inputOther: 1, output: 9 })
      ]
    })
    const file: KimiUsageSessionFile = { ...(await stat(wirePath)), path: wirePath, statePath }
    const result = await parseKimiUsageWire(file, await noWorktrees())

    expect(result.dailyAggregates).toHaveLength(1)
    expect(result.sessions[0].totalTokens).toBe(20) // 10 + 10, nothing dropped
  })

  it('tolerates malformed lines without aborting the file', async () => {
    const home = await makeHome()
    const { wirePath, statePath } = await writeKimiSession({ home, sessionId: 'session_fff' })
    await writeFile(
      wirePath,
      ['{not-json', JSON.stringify(turnUsageLine({ inputOther: 3, output: 7, time: 1 }))].join('\n')
    )
    const file: KimiUsageSessionFile = { ...(await stat(wirePath)), path: wirePath, statePath }
    const result = await parseKimiUsageWire(file, await noWorktrees())

    expect(result.sessions[0].totalTokens).toBe(10)
  })

  it('attributes a session to a containing worktree and otherwise to unscoped', async () => {
    const home = await makeHome()
    const worktreePath = '/private/tmp/proj'
    const { wirePath, statePath } = await writeKimiSession({
      home,
      sessionId: 'session_ggg',
      workDir: worktreePath,
      wireLines: [turnUsageLine({ inputOther: 8, output: 2, time: 1781853559177 })]
    })
    const worktrees = await buildWorktreesWithCanonicalPaths([
      { repoId: 'repo1', worktreeId: 'wt1', path: worktreePath, displayName: 'proj' }
    ])
    const attributed = await parseKimiUsageWire(
      { ...(await stat(wirePath)), path: wirePath, statePath },
      worktrees
    )
    expect(attributed.sessions[0].primaryWorktreeId).toBe('wt1')

    // A workDir with no matching worktree → unscoped (never mis-attributed).
    const unscoped = await parseKimiUsageWire(
      { ...(await stat(wirePath)), path: wirePath, statePath },
      await noWorktrees()
    )
    expect(unscoped.sessions[0].primaryWorktreeId).toBeNull()
    expect(unscoped.sessions[0].locationBreakdown[0].locationKey).toMatch(/^cwd:/)
  })

  it('returns no events for a session whose wire file does not exist', async () => {
    const home = await makeHome()
    const { statePath } = await writeKimiSession({
      home,
      sessionId: 'session_hhh',
      wireLines: null
    })
    const missingWirePath = join(home, 'sessions', 'missing', 'wire.jsonl')
    const result = await parseKimiUsageWire(
      { path: missingWirePath, statePath, mtimeMs: 0, size: 0 },
      await noWorktrees()
    )
    expect(result.sessions).toHaveLength(0)
  })
})

describe('scanKimiUsage', () => {
  it('aggregates multiple sessions across a Kimi home', async () => {
    const home = await makeHome()
    process.env.KIMI_CODE_HOME = home
    await writeKimiSession({
      home,
      sessionId: 'session_one',
      wireLines: [turnUsageLine({ inputOther: 10, output: 5, time: 1781853559177 })]
    })
    await writeKimiSession({
      home,
      sessionId: 'session_two',
      wireLines: [turnUsageLine({ inputOther: 20, output: 5, time: 1781853559177 })]
    })

    const result = await scanKimiUsage([], [])
    expect(result.sessions).toHaveLength(2)
    const total = result.sessions.reduce((sum, session) => sum + session.totalTokens, 0)
    expect(total).toBe(40) // (10+5) + (20+5)
  })

  it('reuses unchanged files and re-parses a grown wire file', async () => {
    const home = await makeHome()
    process.env.KIMI_CODE_HOME = home
    const { wirePath } = await writeKimiSession({
      home,
      sessionId: 'session_grow',
      wireLines: [turnUsageLine({ inputOther: 10, output: 0, time: 1781853559177 })]
    })

    const first = await scanKimiUsage([], [])
    expect(first.sessions[0].totalTokens).toBe(10)

    // Unchanged → reuse yields the same totals.
    const reused = await scanKimiUsage([], first.processedFiles)
    expect(reused.sessions[0].totalTokens).toBe(10)

    // Append a second turn; mtime+size bump forces a re-parse.
    await writeFile(
      wirePath,
      [
        JSON.stringify(turnUsageLine({ inputOther: 10, output: 0, time: 1781853559177 })),
        JSON.stringify(turnUsageLine({ inputOther: 7, output: 0, time: 1781853559177 }))
      ].join('\n')
    )
    const future = Date.now() / 1000 + 5
    await utimes(wirePath, future, future)

    const regrown = await scanKimiUsage([], reused.processedFiles)
    expect(regrown.sessions[0].totalTokens).toBe(17)
  })

  it('returns an empty result for a Kimi home with no sessions', async () => {
    const home = await makeHome()
    process.env.KIMI_CODE_HOME = home
    await mkdir(join(home, 'sessions'), { recursive: true })
    const result = await scanKimiUsage([], [])
    expect(result.sessions).toHaveLength(0)
    expect(result.dailyAggregates).toHaveLength(0)
  })

  it('lists one session file per session directory', async () => {
    const home = await makeHome()
    process.env.KIMI_CODE_HOME = home
    await writeKimiSession({
      home,
      sessionId: 'session_list_a',
      wireLines: [turnUsageLine({ inputOther: 1, output: 1, time: 1 })]
    })
    await writeKimiSession({
      home,
      sessionId: 'session_list_b',
      wireLines: [turnUsageLine({ inputOther: 1, output: 1, time: 1 })]
    })
    const listed = await listKimiUsageSessionFiles(join(home, 'sessions'))
    expect(listed).toHaveLength(2)
  })
})

function localDay(millis: number): string {
  return localDayFromIso(new Date(millis).toISOString())
}

function localDayFromIso(iso: string): string {
  const parsed = new Date(iso)
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

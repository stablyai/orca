import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexAppServerSessionModule from './codex-app-server-session'

const runCodexAppServerSession = vi.fn()

vi.mock('./codex-app-server-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexAppServerSessionModule>()
  return { ...actual, runCodexAppServerSession }
})
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('../win32-utils', () => ({
  getSpawnArgsForWindows: (command: string, args: string[]) => ({
    spawnCmd: command,
    spawnArgs: args
  })
}))

const { CodexAppServerUnsupportedError } = await import('./codex-app-server-session')
const { _internals, parseCodexThreadGoal, transferCodexThreadGoalBetweenHomes } =
  await import('./codex-thread-goal-transfer')

const ORIGIN = '/data/codex-accounts/a/home'
const TARGET = '/data/codex-accounts/b/home'
const THREAD = '01a006a6-1d07-70a1-bad5-f9110d5845c0'

/** Answers the get session with `goal`, then records every method the set session calls. */
function stubSessions(goal: unknown, calls: { method: string; params: unknown }[]): void {
  let sessionIndex = 0
  runCodexAppServerSession.mockImplementation(async (_invocation, body) => {
    const isGet = sessionIndex === 0
    sessionIndex += 1
    return body({
      request: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return isGet ? goal : {}
      }
    })
  })
}

describe('parseCodexThreadGoal', () => {
  it('reads a goal wrapped in a `goal` envelope and one returned bare', () => {
    expect(
      parseCodexThreadGoal({
        goal: { objective: 'ship it', status: 'active' }
      })
    ).toEqual({
      objective: 'ship it',
      status: 'active'
    })
    expect(parseCodexThreadGoal({ objective: 'ship it' })).toEqual({
      objective: 'ship it'
    })
  })

  it('clears a limit the previous account hit so the goal runs on the new one', () => {
    // Why both spellings: the app-server speaks camelCase and rejects anything
    // else, while the goals DB stores the same states with underscores.
    for (const status of ['usageLimited', 'budgetLimited', 'usage_limited', 'budget_limited']) {
      expect(parseCodexThreadGoal({ objective: 'a', status })?.status).toBe('active')
    }
  })

  it('keeps a status the user chose', () => {
    for (const status of ['paused', 'blocked', 'complete', 'active']) {
      expect(parseCodexThreadGoal({ objective: 'a', status })?.status).toBe(status)
    }
  })

  it('drops a status the app-server would reject rather than lose the objective', () => {
    expect(parseCodexThreadGoal({ objective: 'a', status: 'archived' })).toEqual({
      objective: 'a'
    })
  })

  it('accepts either spelling of the budget field', () => {
    expect(parseCodexThreadGoal({ objective: 'a', token_budget: 500 })?.tokenBudget).toBe(500)
    expect(parseCodexThreadGoal({ objective: 'a', tokenBudget: 500 })?.tokenBudget).toBe(500)
  })

  it('reports no goal for an empty objective or a non-object answer', () => {
    expect(parseCodexThreadGoal({ objective: '   ' })).toBeNull()
    expect(parseCodexThreadGoal(null)).toBeNull()
  })
})

describe('transferCodexThreadGoalBetweenHomes', () => {
  beforeEach(() => {
    runCodexAppServerSession.mockReset()
    _internals.resetGoalRpcCapability()
  })

  it('carries the objective, status and budget but never the usage counters', async () => {
    const calls: { method: string; params: unknown }[] = []
    stubSessions(
      {
        goal: {
          objective: 'ship it',
          status: 'active',
          tokenBudget: 500,
          tokensUsed: 420,
          timeUsedSeconds: 90
        }
      },
      calls
    )

    await expect(
      transferCodexThreadGoalBetweenHomes({
        threadId: THREAD,
        originCodexHomePath: ORIGIN,
        targetCodexHomePath: TARGET
      })
    ).resolves.toBe('transferred')

    expect(calls.map((call) => call.method)).toEqual([
      'thread/goal/get',
      'thread/read',
      'thread/goal/set'
    ])
    expect(calls[2].params).toEqual({
      threadId: THREAD,
      objective: 'ship it',
      status: 'active',
      tokenBudget: 500
    })
  })

  it('writes nothing when the thread has no goal', async () => {
    const calls: { method: string; params: unknown }[] = []
    stubSessions({ goal: null }, calls)

    await expect(
      transferCodexThreadGoalBetweenHomes({
        threadId: THREAD,
        originCodexHomePath: ORIGIN,
        targetCodexHomePath: TARGET
      })
    ).resolves.toBe('no-goal')
    expect(calls.map((call) => call.method)).toEqual(['thread/goal/get'])
  })

  it('skips the RPCs entirely when the account did not move', async () => {
    await expect(
      transferCodexThreadGoalBetweenHomes({
        threadId: THREAD,
        originCodexHomePath: ORIGIN,
        targetCodexHomePath: `${ORIGIN}/`
      })
    ).resolves.toBe('skipped')
    expect(runCodexAppServerSession).not.toHaveBeenCalled()
  })

  it('remembers an unsupported CLI and stops probing it', async () => {
    runCodexAppServerSession.mockRejectedValue(
      new CodexAppServerUnsupportedError('no such method: thread/goal/get')
    )

    const args = {
      threadId: THREAD,
      originCodexHomePath: ORIGIN,
      targetCodexHomePath: TARGET
    }
    await expect(transferCodexThreadGoalBetweenHomes(args)).resolves.toBe('unsupported')
    await expect(transferCodexThreadGoalBetweenHomes(args)).resolves.toBe('unsupported')
    expect(runCodexAppServerSession).toHaveBeenCalledTimes(1)
  })

  it('reports a transient RPC failure without marking the CLI unsupported', async () => {
    runCodexAppServerSession.mockRejectedValueOnce(new Error('spawn EAGAIN'))

    const args = {
      threadId: THREAD,
      originCodexHomePath: ORIGIN,
      targetCodexHomePath: TARGET
    }
    await expect(transferCodexThreadGoalBetweenHomes(args)).resolves.toBe('failed')

    const calls: { method: string; params: unknown }[] = []
    stubSessions({ goal: { objective: 'still here' } }, calls)
    await expect(transferCodexThreadGoalBetweenHomes(args)).resolves.toBe('transferred')
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  continueStructuredAgentSessionsAtLaunch,
  StructuredAgentSessionLaunchContinuationOnce,
  STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
  type StructuredAgentSessionLaunchContinuationDeps
} from './structured-agent-session-launch-continuation'
import type { StructuredAgentSessionResumeCandidate } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'

const offer = (sessionId: string, recordedAt: number): StructuredAgentSessionResumeCandidate => ({
  sessionId,
  workspaceId: 'repo::/repo',
  agent: 'claude',
  work: { kind: 'turn', id: 'turn-1' },
  trigger: 'quit',
  recordedAt,
  latestPrompt: '',
  executionHostId: 'local',
  workspaceKind: 'git-worktree'
})

const ENDS = {
  'chat-crashed': { runtime: 'runtime-crashed', end: 'crash' },
  // An older run's crash, whose own start died before it read the cut.
  'chat-crashed-earlier': { runtime: 'runtime-earlier', end: 'crash' },
  'chat-quit': { runtime: 'runtime-quit', end: 'quit' }
} as const

function launch(resumeWorkOnRestart: boolean) {
  const calls: string[] = []
  const restartResume = {
    adoptCrashCuts: vi.fn(async () => {
      calls.push('adopt')
      return 2
    }),
    continueAfterRestart: vi.fn(async () => {
      calls.push('continue')
      return {
        resumed: [],
        continued: [
          { sessionId: 'continued', outcome: 'continued' as const },
          { sessionId: 'refused', outcome: 'refused' as const }
        ]
      }
    }),
    passOverAutomatic: vi.fn(async () => {
      calls.push('pass over')
    }),
    cutOf: vi.fn(async () => null),
    // The run that just ended started at 3: only what it recorded is its cut.
    list: vi.fn(async () => [offer('chat-quit', 4), offer('chat-quit-before', 2)]),
    listFailures: vi.fn(async () => [])
  }
  const deps: StructuredAgentSessionLaunchContinuationDeps = {
    restartResume,
    store: {
      listHeldSessionIds: () => Object.keys(ENDS),
      replacedRuntime: (sessionId) => {
        const owner = Object.entries(ENDS).find(([id]) => id === sessionId)?.[1]
        if (!owner) {
          return undefined
        }
        return { fence: 1, runtime: owner.runtime, runtimeEnd: owner.end }
      }
    },
    startedAt: 5,
    previousRunStartedAt: 3,
    resumeWorkOnRestart: () => resumeWorkOnRestart
  }
  return { result: continueStructuredAgentSessionsAtLaunch(deps), restartResume, calls, deps }
}

describe('continuing interrupted chats at launch', () => {
  it("offers what each chat's crashed run cut, continues it, then leaves what remains to a person", async () => {
    const { result, restartResume, calls } = launch(true)
    const settled = await result
    expect(settled.continued).toEqual(new Set(['continued']))
    expect(settled.cutByLastRun).toEqual(
      new Set(['chat-crashed', 'chat-crashed-earlier', 'chat-quit'])
    )
    expect(restartResume.adoptCrashCuts).toHaveBeenCalledWith(
      [
        { sessionId: 'chat-crashed', crashedRuntime: 'runtime-crashed' },
        { sessionId: 'chat-crashed-earlier', crashedRuntime: 'runtime-earlier' }
      ],
      5
    )
    expect(restartResume.continueAfterRestart).toHaveBeenCalledWith(
      undefined,
      STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
      undefined,
      { automatic: true, onReserved: expect.any(Function) }
    )
    expect(calls).toEqual(['adopt', 'continue', 'pass over'])
  })

  it('with the setting off, still offers what a crash cut and passes it over, continuing nothing', async () => {
    const { result, restartResume, calls } = launch(false)
    expect((await result).continued).toEqual(new Set())
    expect(restartResume.continueAfterRestart).not.toHaveBeenCalled()
    expect(calls).toEqual(['adopt', 'pass over'])
  })

  it('names the chats it took before their agents start, and none when the setting is off', async () => {
    const reserved = Promise.withResolvers<void>()
    const on = launch(true)
    on.restartResume.continueAfterRestart.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as { onReserved: (rows: { sessionId: string }[]) => void }
      options.onReserved([{ sessionId: 'chat-crashed' }])
      await reserved.promise
      return { resumed: [], continued: [] }
    })
    const once = new StructuredAgentSessionLaunchContinuationOnce()
    once.start(on.deps)
    expect((await once.taken).map((row) => row.sessionId)).toEqual(['chat-crashed'])
    reserved.resolve()
    await once.done

    const off = new StructuredAgentSessionLaunchContinuationOnce()
    off.start(launch(false).deps)
    expect(await off.taken).toEqual([])
  })

  it('lets waiters go on without a host, and still runs once a retried restoration has one', async () => {
    const once = new StructuredAgentSessionLaunchContinuationOnce()
    once.start(undefined)
    expect((await once.done).continued).toEqual(new Set())
    const { deps, restartResume } = launch(true)
    once.start(deps)
    once.start(deps)
    await vi.waitFor(() => expect(restartResume.continueAfterRestart).toHaveBeenCalledTimes(2))
  })
})

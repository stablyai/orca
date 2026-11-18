import { describe, expect, it, vi } from 'vitest'
import {
  continueStructuredAgentSessionsAtLaunch,
  StructuredAgentSessionLaunchContinuationOnce,
  STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
  type StructuredAgentSessionLaunchContinuationDeps
} from './structured-agent-session-launch-continuation'

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
    cutOf: vi.fn(async () => null)
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
    resumeWorkOnRestart: () => resumeWorkOnRestart
  }
  return { result: continueStructuredAgentSessionsAtLaunch(deps), restartResume, calls, deps }
}

describe('continuing interrupted chats at launch', () => {
  it("offers what each chat's crashed run cut, continues it, then leaves what remains to a person", async () => {
    const { result, restartResume, calls } = launch(true)
    expect((await result).continued).toEqual(new Set(['continued']))
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
      { automatic: true }
    )
    expect(calls).toEqual(['adopt', 'continue', 'pass over'])
  })

  it('with the setting off, still offers what a crash cut and passes it over, continuing nothing', async () => {
    const { result, restartResume, calls } = launch(false)
    expect((await result).continued).toEqual(new Set())
    expect(restartResume.continueAfterRestart).not.toHaveBeenCalled()
    expect(calls).toEqual(['adopt', 'pass over'])
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

import { describe, expect, it, vi } from 'vitest'
import {
  continueStructuredAgentSessionsAtLaunch,
  StructuredAgentSessionLaunchContinuationOnce,
  STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
  type StructuredAgentSessionLaunchContinuationDeps
} from './structured-agent-session-launch-continuation'

function launch(resumeWorkOnRestart: boolean, end: 'crash' | 'quit' = 'crash') {
  const adoptCrashCuts = vi.fn(async () => 1)
  const continueAfterRestart = vi.fn(async () => ({
    resumed: [],
    continued: [
      { sessionId: 'continued', outcome: 'continued' as const },
      { sessionId: 'refused', outcome: 'refused' as const }
    ]
  }))
  const result = continueStructuredAgentSessionsAtLaunch({
    restartResume: { adoptCrashCuts, continueAfterRestart },
    store: {
      listHeldSessionIds: () => ['chat-1', 'chat-older'],
      replacedRuntime: (sessionId: string) => ({
        fence: 1,
        runtime: sessionId === 'chat-1' ? 'runtime-crashed' : 'runtime-older'
      })
    },
    recentRuns: async () => [
      { runtime: 'runtime-crashed', startedAt: 4, end },
      { runtime: 'runtime-older', startedAt: 2, end: 'crash' as const }
    ],
    startedAt: 5,
    resumeWorkOnRestart: () => resumeWorkOnRestart
  })
  return { result, adoptCrashCuts, continueAfterRestart }
}

describe('continuing interrupted chats at launch', () => {
  it('offers what a crash cut and continues it on its own, skipping what a person must answer', async () => {
    const { result, adoptCrashCuts, continueAfterRestart } = launch(true)
    expect((await result).continued).toEqual(new Set(['continued']))
    expect(adoptCrashCuts).toHaveBeenCalledWith(['chat-1'], 'runtime-crashed', 5)
    expect(continueAfterRestart).toHaveBeenCalledWith(
      undefined,
      STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
      undefined,
      {
        automatic: {
          runs: [
            { runtime: 'runtime-crashed', startedAt: 4, end: 'crash' },
            { runtime: 'runtime-older', startedAt: 2, end: 'crash' }
          ],
          thisRunStartedAt: 5
        }
      }
    )
  })

  it('with the setting off, still offers what a crash cut but continues nothing', async () => {
    const { result, adoptCrashCuts, continueAfterRestart } = launch(false)
    expect((await result).continued).toEqual(new Set())
    expect(adoptCrashCuts).toHaveBeenCalledOnce()
    expect(continueAfterRestart).not.toHaveBeenCalled()
  })

  it('after a quit, offers only what the quit recorded', async () => {
    const { result, adoptCrashCuts, continueAfterRestart } = launch(true, 'quit')
    await result
    expect(adoptCrashCuts).not.toHaveBeenCalled()
    expect(continueAfterRestart).toHaveBeenCalledOnce()
  })

  it('lets waiters go on without a host, and still runs once a retried restoration has one', async () => {
    const once = new StructuredAgentSessionLaunchContinuationOnce()
    once.start(undefined)
    expect((await once.done).continued).toEqual(new Set())
    const continueAfterRestart = vi.fn(async () => ({ resumed: [], continued: [] }))
    const deps: StructuredAgentSessionLaunchContinuationDeps = {
      restartResume: { adoptCrashCuts: vi.fn(async () => 0), continueAfterRestart },
      store: { listHeldSessionIds: () => [], replacedRuntime: () => undefined },
      recentRuns: async () => [],
      startedAt: 0,
      resumeWorkOnRestart: () => true
    }
    once.start(deps)
    once.start(deps)
    await vi.waitFor(() => expect(continueAfterRestart).toHaveBeenCalledOnce())
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  continueStructuredAgentSessionsAtLaunch,
  STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER
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
    previousRun: async () => ({ runtime: 'runtime-crashed', end }),
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
      { automatic: true }
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
})

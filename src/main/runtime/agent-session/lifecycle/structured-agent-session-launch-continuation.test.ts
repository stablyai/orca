import { describe, expect, it, vi } from 'vitest'
import {
  continueStructuredAgentSessionsAtLaunch,
  type StructuredAgentSessionLaunchContinuationDeps
} from './structured-agent-session-launch-continuation'

// What the last run cut and this start left is the same set the restart offer shows, whether or not
// this start continues on its own; only `automatic` says which.
function deps(resumeWorkOnRestart: boolean) {
  const continueAfterRestart = vi.fn(async () => ({ resumed: [], continued: [] }))
  const launch: StructuredAgentSessionLaunchContinuationDeps = {
    restartResume: {
      adoptCrashCuts: async () => 1,
      continueAfterRestart,
      passOverAutomatic: async () => {},
      list: async () => [],
      listFailures: async () => []
    },
    store: {
      listHeldSessionIds: () => ['cut-chat'],
      replacedRuntime: () => ({ runtime: 'last-run', fence: 1, runtimeEnd: 'crash' })
    },
    startedAt: 2_000,
    previousRunStartedAt: async () => 1_000,
    resumeWorkOnRestart: () => resumeWorkOnRestart
  }
  return { launch, continueAfterRestart }
}

describe('continueStructuredAgentSessionsAtLaunch', () => {
  it('names the chats the last run cut with the setting off, continuing none', async () => {
    const { launch, continueAfterRestart } = deps(false)
    const settled = await continueStructuredAgentSessionsAtLaunch(launch)
    expect(settled.automatic).toBe(false)
    expect([...settled.cutByLastRun]).toEqual(['cut-chat'])
    expect(continueAfterRestart).not.toHaveBeenCalled()
  })

  it('names the same chats with the setting on when it continued none of them', async () => {
    const settled = await continueStructuredAgentSessionsAtLaunch(deps(true).launch)
    expect(settled.automatic).toBe(true)
    expect([...settled.cutByLastRun]).toEqual(['cut-chat'])
  })
})

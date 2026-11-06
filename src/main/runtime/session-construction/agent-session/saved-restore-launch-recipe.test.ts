import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { resolveSavedRestoreLaunchRecipe } from './saved-restore-launch-recipe'

const session = { key: 'session_id', id: 'abc' } as const
const record = {
  paneKey: 'tab:leaf',
  worktreeId: 'wt',
  agent: 'claude',
  providerSession: session,
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  launchConfig: { agentArgs: '--dangerously-skip-permissions --verbose', agentEnv: { K: 'v' } }
} satisfies SleepingAgentSessionRecord
const bypassRow = {
  paneKey: 'tab:leaf',
  agentType: 'claude',
  providerSession: { ...session, permissionMode: 'bypassPermissions' }
} as AgentStatusIpcPayload

describe('a client restoring a pane on this host', () => {
  it("replays this host's recorded recipe over the client's Arguments", () => {
    expect(
      resolveSavedRestoreLaunchRecipe({
        agent: 'claude',
        providerSession: session,
        record,
        liveRow: undefined,
        clientAgentArgs: '--verbose'
      })
    ).toEqual(record.launchConfig)
  })

  it('without any recipe, keeps a bypass only this host saw reported', () => {
    const restore = (liveRow: AgentStatusIpcPayload | undefined) =>
      resolveSavedRestoreLaunchRecipe({
        agent: 'claude',
        providerSession: session,
        record: undefined,
        liveRow,
        clientAgentArgs: undefined
      })?.agentArgs
    expect(restore(bypassRow)).toBe('--dangerously-skip-permissions')
    expect(restore(undefined)).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { selectExactWorkerProviderSession } from './worker-provider-session'

function status(
  paneKey: string,
  sessionId: string,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey,
    connectionId: null,
    receivedAt: 200,
    stateStartedAt: 190,
    state: 'working',
    prompt: '',
    agentType: 'codex',
    providerSession: { key: 'session_id', id: sessionId },
    ...overrides
  }
}

describe('exact worker provider session selection', () => {
  it('selects only the current pane, connection, and observation window', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      connectionId: 'ssh-windows',
      launchToken: undefined,
      observedAfter: 150,
      statuses: [
        status('tab:sibling', 'sibling', { connectionId: 'ssh-windows', receivedAt: 300 }),
        status('tab:worker', 'old', { connectionId: 'ssh-windows', receivedAt: 100 }),
        status('tab:worker', 'wrong-host', { connectionId: 'ssh-mac', receivedAt: 400 }),
        status('tab:worker', 'exact', { connectionId: 'ssh-windows', receivedAt: 250 })
      ]
    })

    expect(selected).toEqual({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'exact' },
      observedAt: 250
    })
  })

  it('rejects stale and provider-session-only rows', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:incarnation',
        connectionId: null,
        launchToken: undefined,
        observedAfter: 300,
        statuses: [
          status('tab:worker', 'stale', { receivedAt: 200 }),
          status('tab:worker', 'identity-only', {
            receivedAt: 400,
            providerSessionOnly: true
          })
        ]
      })
    ).toBeNull()
  })

  it('rejects a prior process snapshot when the launch token changed', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:new-incarnation',
        connectionId: null,
        launchToken: 'launch-new',
        observedAfter: 0,
        statuses: [status('tab:worker', 'prior', { launchToken: 'launch-old' })]
      })
    ).toBeNull()
  })
})

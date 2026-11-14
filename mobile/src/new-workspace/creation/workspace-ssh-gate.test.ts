import { describe, expect, it } from 'vitest'
import { deriveWorkspaceSshGate, type WorkspaceSshRecord } from './workspace-ssh-gate'

describe('workspace SSH gate', () => {
  it('ignores stale SSH state from a previously selected repository', () => {
    expect(
      deriveWorkspaceSshGate({
        connectionId: 'ssh-2',
        state: { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 },
        connecting: false
      })
    ).toEqual({
      status: null,
      requiresConnection: true,
      connectInProgress: false,
      error: null,
      needsDesktopServerRecovery: false
    })
  })

  it('asks for the desktop recovery only for the refusal the desktop offers it on', () => {
    const named = 'run `orcad --reclaim-stale-lock --data-root /home/dev/.orca` there'
    const gate = (managedServer: WorkspaceSshRecord['managedServer']) =>
      deriveWorkspaceSshGate({
        connectionId: 'ssh-1',
        state: { targetId: 'ssh-1', status: 'connected', managedServer },
        connecting: false
      }).needsDesktopServerRecovery
    const refused = { kind: 'managed', serving: { state: 'unverifiable', detail: named } }
    expect(gate(refused)).toBe(true)
    expect(gate({ ...refused, serving: { ...refused.serving, detail: 'did not answer' } })).toBe(
      false
    )
    expect(gate({ ...refused, kind: 'relay' })).toBe(false)
    expect(gate({ ...refused, serving: { detail: named } })).toBe(false)
  })
})

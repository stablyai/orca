import { describe, expect, it } from 'vitest'
import {
  deriveWorkspaceSshGate,
  workspaceSshStatusLabel,
  type WorkspaceSshRecord
} from './workspace-ssh-gate'

describe('workspace SSH gate', () => {
  it('does not gate local repositories', () => {
    expect(
      deriveWorkspaceSshGate({
        connectionId: null,
        state: null,
        connecting: false
      })
    ).toEqual({
      status: null,
      requiresConnection: false,
      connectInProgress: false,
      error: null,
      needsDesktopServerRecovery: false
    })
  })

  it('requires connection for remote repos until the matching target is connected', () => {
    expect(
      deriveWorkspaceSshGate({
        connectionId: 'ssh-1',
        state: null,
        connecting: false
      })
    ).toMatchObject({ status: null, requiresConnection: true })

    expect(
      deriveWorkspaceSshGate({
        connectionId: 'ssh-1',
        state: { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 },
        connecting: false
      })
    ).toMatchObject({ status: 'connected', requiresConnection: false })
  })

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

  it('marks connecting, relay deploy, and reconnect states as in progress', () => {
    for (const status of ['connecting', 'deploying-relay', 'reconnecting'] as const) {
      expect(
        deriveWorkspaceSshGate({
          connectionId: 'ssh-1',
          state: { targetId: 'ssh-1', status, error: null, reconnectAttempt: 0 },
          connecting: false
        })
      ).toMatchObject({ requiresConnection: true, connectInProgress: true })
    }
  })

  it('keeps auth and relay errors visible in the drawer', () => {
    expect(
      deriveWorkspaceSshGate({
        connectionId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'auth-failed',
          error: 'Permission denied',
          reconnectAttempt: 0
        },
        connecting: false
      })
    ).toMatchObject({
      status: 'auth-failed',
      requiresConnection: true,
      connectInProgress: false,
      error: 'Permission denied'
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

  it('labels user-visible SSH states', () => {
    expect(workspaceSshStatusLabel(null)).toBe('Disconnected')
    expect(workspaceSshStatusLabel('deploying-relay')).toBe('Deploying relay')
    expect(workspaceSshStatusLabel('auth-failed')).toBe('Authentication failed')
    expect(workspaceSshStatusLabel('connected')).toBe('Connected')
  })
})

import { describe, expect, it } from 'vitest'
import { deriveWorkspaceSshGate, workspaceSshStatusLabel } from './workspace-ssh-gate'

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
      error: null
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
      error: null
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

  it('labels user-visible SSH states', () => {
    expect(workspaceSshStatusLabel(null)).toBe('Disconnected')
    expect(workspaceSshStatusLabel('deploying-relay')).toBe('Deploying relay')
    expect(workspaceSshStatusLabel('auth-failed')).toBe('Authentication failed')
    expect(workspaceSshStatusLabel('connected')).toBe('Connected')
  })
})

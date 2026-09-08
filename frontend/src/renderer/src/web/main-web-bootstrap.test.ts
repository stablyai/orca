// @vitest-environment happy-dom
// FE-TASK-STORAGE-015: auth-failure must not wipe local state; a genuine
// user-identity change on re-auth must still wipe it (FE-SOL-STORAGE-007 (a)).
import { describe, expect, it, beforeEach } from 'vitest'
import { saveStoredWebRuntimeEnvironment } from './web-runtime-environment'
import { installAuthFailedRedirect, enforceWorkspaceOwnerOnReauth } from './main-web-bootstrap'

const WORKSPACE_SESSION_KEY = 'orca.web.workspaceSession.v1'

function markSessionAuthEnvironment(): void {
  // installAuthFailedRedirect only acts for the session-auth (web multi-user)
  // environment — see its `env?.id !== 'session-auth'` guard.
  saveStoredWebRuntimeEnvironment({
    id: 'session-auth',
    name: 'Orca Session',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-session-auth',
    endpoints: [
      {
        id: 'ws-session-auth',
        kind: 'websocket',
        label: 'Session WebSocket',
        endpoint: 'wss://example.com/ws',
        deviceToken: '',
        publicKeyB64: ''
      }
    ]
  })
}

describe('installAuthFailedRedirect (FE-TASK-STORAGE-015)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    // jsdom/happy-dom throws on direct navigation; stub it out so the handler
    // can run to completion and we can assert on the attempted redirect.
    delete (window as unknown as { location?: unknown }).location
    ;(window as unknown as { location: { href: string; hostname: string } }).location = {
      href: '',
      hostname: 'example.com'
    }
  })

  it('does NOT clear localStorage/sessionStorage on auth failure, but still redirects to /login', () => {
    markSessionAuthEnvironment()
    window.localStorage.setItem('orca.saved-instances', JSON.stringify([{ id: '1' }]))
    window.sessionStorage.setItem('some-ephemeral-key', 'keep-me')

    installAuthFailedRedirect()
    window.dispatchEvent(new Event('orca:auth-failed'))

    expect(window.localStorage.getItem('orca.saved-instances')).not.toBeNull()
    expect(window.sessionStorage.getItem('some-ephemeral-key')).toBe('keep-me')
    expect(window.location.href).toBe('/login')
  })

  it('ignores the event when there is no session-auth environment stored', () => {
    // No environment saved at all → env?.id !== 'session-auth' → early return.
    installAuthFailedRedirect()
    window.dispatchEvent(new Event('orca:auth-failed'))

    expect(window.location.href).toBe('')
  })

  it('only redirects once even if the event fires again', () => {
    markSessionAuthEnvironment()
    installAuthFailedRedirect()
    window.dispatchEvent(new Event('orca:auth-failed'))
    window.location.href = ''
    window.dispatchEvent(new Event('orca:auth-failed'))

    expect(window.location.href).toBe('')
  })
})

describe('enforceWorkspaceOwnerOnReauth (FE-SOL-STORAGE-007 (a))', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('keeps state and stamps ownerUserId on first-ever login (no prior owner recorded)', () => {
    window.localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify({ activeRepoId: 'repo-1' }))
    window.localStorage.setItem('orca.saved-instances', JSON.stringify([{ id: '1' }]))

    enforceWorkspaceOwnerOnReauth('user-1')

    expect(window.localStorage.getItem('orca.saved-instances')).not.toBeNull()
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_KEY)!)
    expect(stored.activeRepoId).toBe('repo-1')
    expect(stored.ownerUserId).toBe('user-1')
  })

  it('preserves all local state when the SAME user re-authenticates', () => {
    window.localStorage.setItem(
      WORKSPACE_SESSION_KEY,
      JSON.stringify({ activeRepoId: 'repo-1', ownerUserId: 'user-1' })
    )
    window.localStorage.setItem('orca.saved-instances', JSON.stringify([{ id: '1' }]))
    window.sessionStorage.setItem('some-ephemeral-key', 'keep-me')

    enforceWorkspaceOwnerOnReauth('user-1')

    expect(window.localStorage.getItem('orca.saved-instances')).not.toBeNull()
    expect(window.sessionStorage.getItem('some-ephemeral-key')).toBe('keep-me')
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_KEY)!)
    expect(stored.activeRepoId).toBe('repo-1')
    expect(stored.ownerUserId).toBe('user-1')
  })

  it('wipes all local state when a DIFFERENT user re-authenticates, then stamps the new owner', () => {
    window.localStorage.setItem(
      WORKSPACE_SESSION_KEY,
      JSON.stringify({ activeRepoId: 'repo-1', ownerUserId: 'user-1' })
    )
    window.localStorage.setItem('orca.saved-instances', JSON.stringify([{ id: '1' }]))
    window.sessionStorage.setItem('some-ephemeral-key', 'do-not-keep')

    enforceWorkspaceOwnerOnReauth('user-2')

    expect(window.localStorage.getItem('orca.saved-instances')).toBeNull()
    expect(window.sessionStorage.getItem('some-ephemeral-key')).toBeNull()
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_KEY)!)
    expect(stored.activeRepoId).toBeUndefined()
    expect(stored.ownerUserId).toBe('user-2')
  })

  it('tolerates malformed JSON in the stored session (treats as no recorded owner)', () => {
    window.localStorage.setItem(WORKSPACE_SESSION_KEY, '{not-json')
    window.localStorage.setItem('orca.saved-instances', JSON.stringify([{ id: '1' }]))

    expect(() => enforceWorkspaceOwnerOnReauth('user-1')).not.toThrow()
    // Malformed JSON is not a recognized "different owner" — no wipe.
    expect(window.localStorage.getItem('orca.saved-instances')).not.toBeNull()
  })
})

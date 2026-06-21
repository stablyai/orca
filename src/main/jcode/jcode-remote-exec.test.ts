import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { JcodeChatSendPayload } from '../../shared/jcode-chat-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { resolveRemoteExec } from './jcode-remote-exec'

/** Minimal Store stub: only the lookups resolveRemoteExec touches. */
function makeStore(overrides: Partial<Record<keyof Store, unknown>>): Store {
  return {
    getFolderWorkspace: () => undefined,
    getRepo: () => undefined,
    getSshTarget: () => undefined,
    ...overrides
  } as unknown as Store
}

function payload(extra: Partial<JcodeChatSendPayload>): JcodeChatSendPayload {
  return { sessionKey: 's', prompt: 'p', ...extra } as JcodeChatSendPayload
}

describe('resolveRemoteExec', () => {
  it('resolves a GIT worktree (raw repoId::path id) to host + connection + remote path', () => {
    const store = makeStore({
      getRepo: (id: string) =>
        id === 'repo-1' ? { id: 'repo-1', connectionId: 'conn-1' } : undefined,
      getSshTarget: (id: string) =>
        id === 'conn-1' ? { configHost: 'comfyui-host', host: '10.0.0.5' } : undefined
    })
    const result = resolveRemoteExec(store, payload({ worktreeId: 'repo-1::/home/srain/ComfyUI' }))
    expect(result).toEqual({
      host: 'comfyui-host',
      connectionId: 'conn-1',
      remotePath: '/home/srain/ComfyUI'
    })
  })

  it('resolves a worktree:-prefixed git worktree key the same way', () => {
    const store = makeStore({
      getRepo: () => ({ id: 'repo-1', connectionId: 'conn-1' }),
      getSshTarget: () => ({ host: '10.0.0.5' })
    })
    const result = resolveRemoteExec(
      store,
      payload({ worktreeId: worktreeWorkspaceKey('repo-1::/home/srain/ComfyUI') })
    )
    expect(result.host).toBe('10.0.0.5')
    expect(result.connectionId).toBe('conn-1')
    expect(result.remotePath).toBe('/home/srain/ComfyUI')
  })

  it('still resolves a remote FOLDER workspace via folderPath', () => {
    const store = makeStore({
      getFolderWorkspace: (id: string) =>
        id === 'fw-1' ? { connectionId: 'conn-2', folderPath: '/srv/proj' } : undefined,
      getSshTarget: () => ({ configHost: 'folder-host' })
    })
    const result = resolveRemoteExec(store, payload({ worktreeId: folderWorkspaceKey('fw-1') }))
    expect(result).toEqual({
      host: 'folder-host',
      connectionId: 'conn-2',
      remotePath: '/srv/proj'
    })
  })

  it('returns local (host null) for a git worktree whose repo has no connection', () => {
    const store = makeStore({ getRepo: () => ({ id: 'repo-1', connectionId: null }) })
    const result = resolveRemoteExec(store, payload({ worktreeId: 'repo-1::/Users/me/proj' }))
    expect(result).toEqual({ host: null, connectionId: null, remotePath: null })
  })

  it('falls back to payload.cwd for the remote path when the worktree path is empty', () => {
    const store = makeStore({
      getRepo: () => ({ id: 'repo-1', connectionId: 'conn-1' }),
      getSshTarget: () => ({ host: 'h' })
    })
    // No `::` separator → no path segment; cwd carries the remote path.
    const result = resolveRemoteExec(
      store,
      payload({ worktreeId: 'repo-1', cwd: '/remote/from/cwd' })
    )
    expect(result.remotePath).toBe('/remote/from/cwd')
  })

  it('honors the explicit remoteExecHost override with no store binding', () => {
    const result = resolveRemoteExec(undefined, payload({ remoteExecHost: 'adhoc-host' }))
    expect(result).toEqual({ host: 'adhoc-host', connectionId: null, remotePath: null })
  })
})

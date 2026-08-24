import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshTarget } from '../../shared/ssh-types'
import { getActiveMultiplexer } from './ssh'
import { CLIENT_ID } from './remote-workspace-client-identity'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { isCurrentSshProviderAuthority } from '../ssh/ssh-provider-authority'
import {
  getCachedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import {
  normalizeSnapshot,
  remoteWorkspaceSessionMatchesSnapshot
} from './remote-workspace-snapshot-normalization'

export async function getRemoteSnapshot(
  target: SshTarget,
  authority: DirectSshAuthority
): Promise<RemoteWorkspaceSnapshot | null> {
  const mux = getActiveMultiplexer(target.id)
  if (!mux || authority.targetId !== target.id || !isCurrentSshProviderAuthority(authority)) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  try {
    const raw = await mux.request('workspace.get', { namespace })
    if (!isCurrentSshProviderAuthority(authority)) {
      return null
    }
    const snapshot = normalizeSnapshot(raw, namespace)
    rememberRemoteWorkspaceSnapshot(authority, snapshot)
    return snapshot
  } catch (err) {
    if (!isCurrentSshProviderAuthority(authority)) {
      return null
    }
    if ((err as { code?: unknown })?.code === -32601) {
      return null
    }
    throw err
  }
}

export async function patchRemoteWorkspaceSession(
  target: SshTarget,
  session: RemoteWorkspaceSession,
  authority: DirectSshAuthority
): Promise<RemoteWorkspacePatchResult | null> {
  if (authority.targetId !== target.id || !isCurrentSshProviderAuthority(authority)) {
    return null
  }
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const current =
    getCachedRemoteWorkspaceSnapshot(authority) ??
    (await getRemoteSnapshot(target, authority)) ??
    undefined
  if (!isCurrentSshProviderAuthority(authority)) {
    return null
  }
  if (current && remoteWorkspaceSessionMatchesSnapshot(current, session)) {
    // Why: a pulled workspace snapshot rehydrates local state and can trigger
    // session persistence. Identical target sessions must stay a local no-op or
    // two clients will echo revisions indefinitely.
    return { ok: true, snapshot: current }
  }

  const requestPatch = async (
    baseRevision: number | undefined
  ): Promise<RemoteWorkspacePatchResult | null> => {
    if (!isCurrentSshProviderAuthority(authority)) {
      return null
    }
    try {
      return (await mux.request('workspace.patch', {
        namespace,
        baseRevision: baseRevision ?? 0,
        clientId: CLIENT_ID,
        patch: { kind: 'replace-session', session }
      })) as RemoteWorkspacePatchResult
    } catch (err) {
      if (!isCurrentSshProviderAuthority(authority)) {
        return null
      }
      return (err as { code?: unknown })?.code === -32601
        ? {
            ok: false,
            reason: 'unavailable',
            message: 'Remote workspace sync is unavailable on this relay'
          }
        : {
            ok: false,
            reason: 'unavailable',
            message: err instanceof Error ? err.message : 'Remote workspace sync failed'
          }
    }
  }

  const result = await requestPatch(current?.revision)
  if (!result) {
    return null
  }
  if (result.ok) {
    rememberRemoteWorkspaceSnapshot(authority, result.snapshot)
    return result
  }
  if (result.snapshot) {
    rememberRemoteWorkspaceSnapshot(authority, result.snapshot)
  }

  if (
    result.reason === 'stale-revision' &&
    current &&
    result.snapshot &&
    result.snapshot.revision < current.revision
  ) {
    if (remoteWorkspaceSessionMatchesSnapshot(result.snapshot, session)) {
      return { ok: true, snapshot: result.snapshot }
    }
    // Why: a relay reset can legitimately move the remote snapshot revision
    // backwards while this process still has the old cached revision. Retrying
    // only for backwards revisions restores the blank-slate target without
    // overwriting a newer snapshot from another device.
    const retry = await requestPatch(result.snapshot.revision)
    if (!retry) {
      return null
    }
    if (retry.ok) {
      rememberRemoteWorkspaceSnapshot(authority, retry.snapshot)
    } else if (retry.snapshot) {
      rememberRemoteWorkspaceSnapshot(authority, retry.snapshot)
    }
    return retry
  }

  return result
}

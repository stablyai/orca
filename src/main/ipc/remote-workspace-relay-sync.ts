import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getActiveMultiplexer } from './ssh'
import { CLIENT_ID } from './remote-workspace-client-identity'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import {
  getCachedRemoteWorkspaceSnapshot,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import {
  normalizeSnapshot,
  remoteWorkspaceSessionMatchesSnapshot
} from './remote-workspace-snapshot-normalization'

export async function getRemoteSnapshot(
  target: SshTarget
): Promise<RemoteWorkspaceObservedSnapshot | null> {
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  try {
    const raw = await mux.request('workspace.get', { namespace })
    const snapshot = normalizeSnapshot(raw, namespace)
    return rememberRemoteWorkspaceSnapshot(target.id, snapshot)
  } catch (err) {
    if ((err as { code?: unknown })?.code === -32601) {
      return null
    }
    throw err
  }
}

function observePatchResult(
  targetId: string,
  result: RemoteWorkspacePatchResult
): RemoteWorkspaceObservedPatchResult {
  if (result.ok) {
    return {
      ok: true,
      snapshot: rememberLocallyPatchedRemoteWorkspaceSnapshot(targetId, result.snapshot)
    }
  }
  const failure = {
    ok: false as const,
    reason: result.reason,
    ...(result.message !== undefined ? { message: result.message } : {})
  }
  return result.snapshot
    ? {
        ...failure,
        snapshot: rememberRemoteWorkspaceSnapshot(targetId, result.snapshot)
      }
    : failure
}

export async function patchRemoteWorkspaceSession(
  target: SshTarget,
  session: RemoteWorkspaceSession
): Promise<RemoteWorkspaceObservedPatchResult | null> {
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const current =
    getCachedRemoteWorkspaceSnapshot(target.id) ?? (await getRemoteSnapshot(target)) ?? undefined
  if (current && remoteWorkspaceSessionMatchesSnapshot(current, session)) {
    // Why: a pulled workspace snapshot rehydrates local state and can trigger
    // session persistence. Identical target sessions must stay a local no-op or
    // two clients will echo revisions indefinitely.
    return { ok: true, snapshot: current }
  }

  const requestPatch = async (
    baseRevision: number | undefined
  ): Promise<RemoteWorkspacePatchResult> => {
    try {
      return (await mux.request('workspace.patch', {
        namespace,
        baseRevision: baseRevision ?? 0,
        clientId: CLIENT_ID,
        patch: { kind: 'replace-session', session }
      })) as RemoteWorkspacePatchResult
    } catch (err) {
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

  const result = observePatchResult(target.id, await requestPatch(current?.revision))
  if (result.ok) {
    return result
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
    return observePatchResult(target.id, await requestPatch(result.snapshot.revision))
  }

  return result
}

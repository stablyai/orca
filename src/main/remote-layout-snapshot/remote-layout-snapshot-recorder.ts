// The one writer of the display-only server layout snapshot (design 6.3, D3). It records the
// `session.tabs.subscribeAll` frames main already relays to the window, so no server receives a
// new request. Its one reader, `layout.getRemoteSnapshots`, has no caller yet.

import type {
  RemoteLayoutSnapshot,
  RemoteLayoutSnapshotWorkspace
} from '../../shared/remote-layout-snapshot'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-session-contracts'

export type RemoteLayoutSnapshotStore = {
  getRemoteLayoutSnapshot(environmentId: string): RemoteLayoutSnapshot | undefined
  setRemoteLayoutSnapshot(
    environmentId: string,
    snapshot: RemoteLayoutSnapshot | null,
    save: 'now' | 'later'
  ): void
}

type SessionTabsFrame =
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
  | (RuntimeMobileSessionTabsResult & { type: 'updated'; removed?: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Checks the identity fields only; the rest is the server's published contract.
function isSessionTabsResult(value: unknown): value is RuntimeMobileSessionTabsResult {
  return isRecord(value) && typeof value.worktree === 'string' && Array.isArray(value.tabs)
}

function isSessionTabsFrame(value: unknown): value is SessionTabsFrame {
  if (!isRecord(value)) {
    return false
  }
  return value.type === 'snapshots'
    ? Array.isArray(value.snapshots) && value.snapshots.every(isSessionTabsResult)
    : value.type === 'updated' && isSessionTabsResult(value)
}

function displayed({
  navigationIntent: _command,
  retiredTerminalSurfaces: _proofs,
  ...workspace
}: RuntimeMobileSessionTabsResult): RemoteLayoutSnapshotWorkspace {
  return workspace
}

// Which tabs exist and where; titles and status change far more often and can wait for a save.
function structure(workspace: RemoteLayoutSnapshotWorkspace | undefined): string {
  return JSON.stringify([
    workspace?.tabs.map((tab) => tab.id),
    workspace?.tabGroups?.map((group) => [group.id, group.tabOrder]),
    workspace?.tabGroupLayout
  ])
}

/** Called for every relayed stream frame; only the window's all-worktree tab stream is recorded. */
export function recordRemoteLayoutFrame(
  store: RemoteLayoutSnapshotStore,
  environmentId: string,
  method: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (method !== 'session.tabs.subscribeAll' || !response.ok) {
    return
  }
  const frame = response.result
  if (!isSessionTabsFrame(frame)) {
    return
  }
  if (frame.type === 'snapshots') {
    // A census replaces the whole entry: a worktree missing from it is gone.
    const workspaces = Object.fromEntries(
      frame.snapshots.map((snapshot) => [snapshot.worktree, displayed(snapshot)])
    )
    store.setRemoteLayoutSnapshot(environmentId, { workspaces }, 'now')
    return
  }
  const { type: _type, removed, ...result } = frame
  const { [frame.worktree]: previous, ...others } =
    store.getRemoteLayoutSnapshot(environmentId)?.workspaces ?? {}
  if (removed) {
    store.setRemoteLayoutSnapshot(environmentId, { workspaces: others }, 'now')
    return
  }
  const workspace = displayed(result)
  store.setRemoteLayoutSnapshot(
    environmentId,
    { workspaces: { ...others, [frame.worktree]: workspace } },
    structure(previous) === structure(workspace) ? 'later' : 'now'
  )
}

/** A removed server's snapshot goes with it. */
export function forgetRemoteLayoutSnapshot(
  store: RemoteLayoutSnapshotStore,
  environmentId: string
): void {
  store.setRemoteLayoutSnapshot(environmentId, null, 'now')
}

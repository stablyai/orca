import { expect, it } from 'vitest'
import {
  captureLegacyRelayBaseline,
  legacyRelayAdoptionBatch
} from './desktop-relay-legacy-adoption'
import { removeWorkspaceSessionOwner } from './restoring-sessions/session-owner-removal'
import type { Repo } from '../../shared/repository/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'

// Perf contract: the legacy relay ids captured at startup live only until their workspace is
// removed, even when no relay write ever reaches that host (its partition failed to load, say).

it("releases a removed workspace's captured legacy relay ids", () => {
  const ssh = getRepoExecutionHostId({ connectionId: 'box' })
  const worktreeId = 'repo-ssh::/w'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal and capture read tab rows and relay ids only.
  const partition = {
    tabsByWorktree: { [worktreeId]: [{ id: 'tab-a', worktreeId }] },
    remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-a' }
  } as unknown as WorkspaceSessionState
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only id and connectionId.
  const repos = [{ id: 'repo-ssh', connectionId: 'box' }] as Repo[]
  const store = {
    getRepos: () => repos,
    getWorkspaceSessionHostIds: (): ExecutionHostId[] => [ssh, LOCAL_EXECUTION_HOST_ID],
    getWorkspaceSession: (hostId?: string | null) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an absent partition is empty here.
      hostId === ssh ? partition : ({} as WorkspaceSessionState)
  }
  const baseline = captureLegacyRelayBaseline(store)

  removeWorkspaceSessionOwner(partition, worktreeId)

  expect(legacyRelayAdoptionBatch(store, baseline, [])(ssh)(partition)).toEqual({})
  expect(baseline.size).toBe(0)
})

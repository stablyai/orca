// A paired server's workspace attached to one of this store's folders keeps that link only in its own
// store: cleanup asks each paired server once per run (its `worktree ps`, as bot Activity does).
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { readCallerStoreInstallationId } from '../../runtime/hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { RuntimeWorktreePsResult } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import { hostScopeCensusIsComplete } from '../../../shared/execution-host/runtime-listing-host-scope'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'

const PAIRED_READ_TIMEOUT_MS = 5_000
const PAIRED_PS_LIMIT = 100_000

export type PairedFolderChildren = {
  /** False when a paired server didn't answer in full: any folder here may have members there. */
  complete: boolean
  /** Host identity of each paired workspace whose parent is in this store, and that parent. */
  children: { identity: string; parentWorkspaceKey: string; parentInstanceId: string }[]
}

export type PairedFolderChildrenRuntime = Pick<
  OrcaRuntimeService,
  'listOrchestrationWorkerServers' | 'callOrchestrationWorkerServer' | 'getRuntimeId'
>

export async function readPairedFolderChildren(
  runtime: PairedFolderChildrenRuntime
): Promise<PairedFolderChildren> {
  const servers = await runtime.listOrchestrationWorkerServers().catch(() => null)
  if (!servers) {
    return { complete: false, children: [] }
  }
  if (servers.length === 0) {
    return { complete: true, children: [] }
  }
  // An unreadable identity can't tell this store's children from anyone else's.
  const own = await readCallerStoreInstallationId(
    runtime.getRuntimeId(),
    getCanonicalUserDataPath()
  ).catch(() => undefined)
  if (!own) {
    return { complete: false, children: [] }
  }
  const answers = await Promise.all(
    servers.map(({ environmentId }) =>
      // The call's own timeout starts after it reaches the server; connecting (an SSH tunnel) can take longer.
      withTimeout(
        runtime
          .callOrchestrationWorkerServer(
            environmentId,
            'worktree.ps',
            { limit: PAIRED_PS_LIMIT },
            PAIRED_READ_TIMEOUT_MS
          )
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `worktree.ps` answers RuntimeWorktreePsResult on every paired Orca; rows are read field by field below.
          .then((result) => ({
            environmentId,
            result: result as Partial<RuntimeWorktreePsResult>
          })),
        PAIRED_READ_TIMEOUT_MS,
        null
      )
    )
  )
  const paired: PairedFolderChildren = { complete: true, children: [] }
  for (const answer of answers) {
    // A host it couldn't list (a failed repo scan, a dropped SSH host) may hold a child too.
    if (
      !answer ||
      answer.result.truncated !== false ||
      !hostScopeCensusIsComplete(answer.result.hostScope) ||
      !Array.isArray(answer.result.worktrees)
    ) {
      paired.complete = false
      continue
    }
    const hostId = toRuntimeExecutionHostId(answer.environmentId)
    for (const row of answer.result.worktrees) {
      const parent = row.crossStoreParent?.parent
      if (parent?.installationId === own) {
        paired.children.push({
          identity: composeWorktreeHostIdentity(hostId, row.worktreeId),
          parentWorkspaceKey: parent.workspaceKey,
          parentInstanceId: parent.instanceId
        })
      }
    }
  }
  return paired
}

/** The read a whole run shares, scan and every re-check: started only when a folder group needs it. */
export function pairedFolderChildrenOnce(
  runtime: PairedFolderChildrenRuntime
): () => Promise<PairedFolderChildren> {
  let read: Promise<PairedFolderChildren> | null = null
  return () => (read ??= readPairedFolderChildren(runtime))
}

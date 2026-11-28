// A paired server's workspace attached to one of this store's folders keeps that link only in its own
// store: cleanup asks each paired server once per run for its saved cross-store links
// (`worktree.lineageList`, as the desktop's lineage refresh does). Saved links don't depend on a Git scan.
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { readCallerStoreInstallationId } from '../../runtime/hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import {
  normalizeCrossStoreLineageByChildKey,
  validCrossStoreLineage
} from '../../../shared/worktree/lineage/cross-store-lineage-records'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import type { CrossStoreWorkspaceLineage } from '../../../shared/worktree/lineage-types'

const PAIRED_READ_TIMEOUT_MS = 5_000
const PAIRED_READ_CONCURRENCY = 4

// A worker's lineage: a folder's other members don't hold a disposable checkout, nor it them.
export function isOrchestrationLineage(
  lineage: Pick<
    CrossStoreWorkspaceLineage,
    'origin' | 'orchestrationRunId' | 'taskId' | 'coordinatorHandle'
  >
): boolean {
  return (
    lineage.origin === 'orchestration' ||
    Boolean(lineage.orchestrationRunId || lineage.taskId || lineage.coordinatorHandle)
  )
}

/** A cross-store link that never joins a folder's group, on either side: a worker's or a bot hand-over. */
export function isUngroupedCrossStoreLineage(lineage: CrossStoreWorkspaceLineage): boolean {
  return isOrchestrationLineage(lineage) || lineage.capture.source === 'bot-hand-over'
}

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
  const answers: ({ environmentId: string; result: unknown } | null)[] = Array.from({
    length: servers.length
  })
  let nextIndex = 0
  const workerCount = Math.min(PAIRED_READ_CONCURRENCY, servers.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < servers.length) {
        const index = nextIndex++
        const { environmentId } = servers[index]
        // Only query already-connected servers so cleanup never wakes idle managed SSH or WSL hosts.
        answers[index] = await withTimeout(
          runtime
            .callOrchestrationWorkerServer(
              environmentId,
              'worktree.lineageList',
              undefined,
              PAIRED_READ_TIMEOUT_MS,
              undefined,
              { readyOnly: true }
            )
            .then((result) => ({ environmentId, result })),
          PAIRED_READ_TIMEOUT_MS,
          null
        )
      }
    })
  )
  const paired: PairedFolderChildren = { complete: true, children: [] }
  for (const answer of answers) {
    try {
      paired.children.push(...childrenOfAnswer(answer, own))
    } catch {
      // A server that didn't answer may hold a child of any folder here.
      paired.complete = false
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

/** The answer's children of this store's folders; throws when it isn't an answer. */
function childrenOfAnswer(
  answer: { environmentId: string; result: unknown } | null,
  own: string
): PairedFolderChildren['children'] {
  if (!answer || typeof answer.result !== 'object' || answer.result === null) {
    throw new Error('no paired lineage answer')
  }
  // A server from before cross-machine parents sends none, and has none.
  if (!('crossStoreLineage' in answer.result) || answer.result.crossStoreLineage === undefined) {
    return []
  }
  const saved = normalizeCrossStoreLineageByChildKey(answer.result.crossStoreLineage)
  const links = validCrossStoreLineage(saved)
  // A link it can't read may be a child of a folder here.
  if (!saved || Object.keys(links).length !== Object.keys(saved).length) {
    throw new Error('unreadable paired lineage')
  }
  const hostId = toRuntimeExecutionHostId(answer.environmentId)
  return Object.values(links).flatMap((link) => {
    const child = parseWorkspaceKey(link.childWorkspaceKey)
    return child?.type === 'worktree' &&
      link.parent.installationId === own &&
      !isUngroupedCrossStoreLineage(link)
      ? [
          {
            identity: composeWorktreeHostIdentity(hostId, child.worktreeId),
            parentWorkspaceKey: link.parent.workspaceKey,
            parentInstanceId: link.parent.instanceId
          }
        ]
      : []
  })
}

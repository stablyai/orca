import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import type { FolderWorkspaceTerminalTeardownTarget } from './folder-workspace-terminal-teardown-targets'
import { withSharedPtyProviderProcessSnapshot } from './pty-provider-process-snapshot'
import { settleBeforeDeadline } from './settle-before-deadline'
import {
  killAllProcessesForWorktree,
  teardownRpcDeadline,
  type WorktreeTeardownResult
} from './worktree-teardown'

const FOLDER_WORKSPACE_TEARDOWN_CONCURRENCY = 4
const FOLDER_WORKSPACE_TEARDOWN_TIMEOUT_MS = 12_000

export {
  resolveFolderWorkspaceTerminalTeardownTargets,
  type FolderWorkspaceTerminalTeardownTarget
} from './folder-workspace-terminal-teardown-targets'

type FolderWorkspaceTerminalTeardownDeps = {
  runtime: OrcaRuntimeService
  getLocalProvider: () => IPtyProvider | null
  getSshProvider: (connectionId: string) => IPtyProvider | undefined
  onPtyStopped?: (ptyId: string) => void
  requirePhysicalSshStop?: boolean
}

type FolderWorkspaceTerminalTeardownJob =
  | {
      kind: 'inventory'
      markReady: () => void
      provider: IPtyProvider
      requirePhysicalStop: boolean
    }
  | {
      kind: 'provider'
      inventoryReady: Promise<void>
      target: FolderWorkspaceTerminalTeardownTarget
      provider: IPtyProvider
    }
  | { kind: 'runtime'; target: FolderWorkspaceTerminalTeardownTarget }

type InventoryJob = Extract<FolderWorkspaceTerminalTeardownJob, { kind: 'inventory' }>
type TargetJob = Exclude<FolderWorkspaceTerminalTeardownJob, { kind: 'inventory' }>

type SharedFolderWorkspaceTeardownProvider = {
  inventoryReady: Promise<void>
  markInventoryReady: () => void
  provider: IPtyProvider
  requirePhysicalStop: boolean
}

function emptyTeardownResult(): WorktreeTeardownResult {
  return { runtimeStopped: 0, providerStopped: 0, registryStopped: 0 }
}

function requiresPhysicalStop(
  target: FolderWorkspaceTerminalTeardownTarget,
  deps: FolderWorkspaceTerminalTeardownDeps
): boolean {
  return deps.requirePhysicalSshStop === true && target.connection.kind === 'ssh'
}

async function stopRuntimeFolderWorkspaceTerminals(
  target: FolderWorkspaceTerminalTeardownTarget,
  deadline: number,
  deps: FolderWorkspaceTerminalTeardownDeps,
  excludedPtyIds?: ReadonlySet<string>
): Promise<WorktreeTeardownResult> {
  if (target.connection.kind === 'ambiguous') {
    return emptyTeardownResult()
  }
  const strict = requiresPhysicalStop(target, deps)
  try {
    if (strict && Date.now() >= deadline) {
      throw new Error(`Folder workspace terminal teardown timed out: ${target.workspaceKey}`)
    }
    const result = await deps.runtime.stopTerminalsForWorktree(target.workspaceKey, {
      deadline,
      stopPty: async (ptyId, stop) => {
        const stopped = await stop()
        if (strict && !stopped) {
          throw new Error(`Unable to verify PTY stopped: ${ptyId}`)
        }
        return { stopped, owner: true }
      },
      excludedPtyIds,
      excludeRemoteRuntimePtys: true,
      resolvedWorktreeId: target.workspaceKey,
      resolvedConnectionId: target.connection.kind === 'ssh' ? target.connection.connectionId : null
    })
    if (strict && Date.now() >= deadline) {
      throw new Error(`Folder workspace terminal teardown timed out: ${target.workspaceKey}`)
    }
    return { ...emptyTeardownResult(), runtimeStopped: result.stopped }
  } catch (error) {
    if (strict) {
      if (
        error instanceof Error &&
        (error.message === 'runtime_unavailable' || error.message === 'selector_not_found')
      ) {
        return emptyTeardownResult()
      }
      throw error
    }
    console.warn(`[folder-workspace-teardown] failed for ${target.workspaceKey}:`, error)
    return emptyTeardownResult()
  }
}

async function stopProviderFolderWorkspaceTerminals(
  target: FolderWorkspaceTerminalTeardownTarget,
  provider: IPtyProvider,
  inventoryReady: Promise<void>,
  deadline: number,
  deps: FolderWorkspaceTerminalTeardownDeps
): Promise<WorktreeTeardownResult> {
  await inventoryReady
  const strict = requiresPhysicalStop(target, deps)
  let physical = emptyTeardownResult()
  const physicallyStoppedPtyIds = new Set<string>()
  try {
    const providerBudgetMs = Math.max(1, Math.floor((deadline - Date.now()) / 2))
    physical = await killAllProcessesForWorktree(target.workspaceKey, {
      resolvedWorktreeId: target.workspaceKey,
      resolvedConnectionId:
        target.connection.kind === 'ssh' ? target.connection.connectionId : null,
      localProvider: provider,
      onPtyStopped: (ptyId) => {
        physicallyStoppedPtyIds.add(ptyId)
        deps.onPtyStopped?.(ptyId)
      },
      timeoutMs: providerBudgetMs,
      ...(strict ? { requirePhysicalStop: true } : {}),
      ...(target.connection.kind === 'ssh' ? { includeLocalRegistry: false } : {})
    })
  } catch (error) {
    if (strict) {
      throw error
    }
    console.warn(`[folder-workspace-teardown] failed for ${target.workspaceKey}:`, error)
  }
  // Why: provider-first avoids one post-stop process inventory per graph PTY.
  const runtime = await stopRuntimeFolderWorkspaceTerminals(
    target,
    deadline,
    deps,
    physicallyStoppedPtyIds
  )
  return { ...physical, runtimeStopped: runtime.runtimeStopped }
}

function getFolderWorkspaceTeardownJobDeadline(
  batchStartedAt: number,
  batchDeadline: number,
  jobCount: number,
  jobIndex: number
): number {
  const waveCount = Math.max(1, Math.ceil(jobCount / FOLDER_WORKSPACE_TEARDOWN_CONCURRENCY))
  const waveNumber = Math.floor(jobIndex / FOLDER_WORKSPACE_TEARDOWN_CONCURRENCY) + 1
  const batchBudgetMs = batchDeadline - batchStartedAt
  const waveCutoffMs = Math.max(1, Math.floor((batchBudgetMs * waveNumber) / waveCount))
  return Math.min(batchDeadline, batchStartedAt + waveCutoffMs)
}

async function inventoryFolderWorkspaceProvider(
  provider: IPtyProvider,
  deadline: number,
  markReady: () => void,
  requirePhysicalStop: boolean
): Promise<WorktreeTeardownResult> {
  try {
    const inventory = provider.listProcesses({ deadlineMs: teardownRpcDeadline(deadline) })
    await settleBeforeDeadline(
      () => inventory,
      [],
      deadline,
      requirePhysicalStop ? new Error('Folder workspace provider inventory timed out') : undefined
    )
  } catch (error) {
    if (requirePhysicalStop) {
      throw error
    }
    // Why: inventory failure must not suppress owner-specific runtime cleanup.
  } finally {
    markReady()
  }
  return emptyTeardownResult()
}

function createSharedFolderWorkspaceTeardownProvider(
  provider: IPtyProvider
): SharedFolderWorkspaceTeardownProvider {
  let markInventoryReady = (): void => {}
  const inventoryReady = new Promise<void>((resolve) => {
    markInventoryReady = resolve
  })
  return {
    inventoryReady,
    markInventoryReady,
    provider: withSharedPtyProviderProcessSnapshot(provider),
    requirePhysicalStop: false
  }
}

export async function stopFolderWorkspaceTerminals(
  targets: readonly FolderWorkspaceTerminalTeardownTarget[],
  deps: FolderWorkspaceTerminalTeardownDeps
): Promise<WorktreeTeardownResult> {
  const batchStartedAt = Date.now()
  const batchDeadline = batchStartedAt + FOLDER_WORKSPACE_TEARDOWN_TIMEOUT_MS
  const sharedProviders = new Map<IPtyProvider, SharedFolderWorkspaceTeardownProvider>()
  const targetJobs: TargetJob[] = []
  for (const target of targets) {
    if (target.connection.kind === 'ambiguous') {
      continue
    }
    const provider =
      target.connection.kind === 'ssh'
        ? deps.getSshProvider(target.connection.connectionId)
        : deps.getLocalProvider()
    if (!provider) {
      if (requiresPhysicalStop(target, deps)) {
        throw new Error(
          `PTY provider unavailable for folder workspace deletion: ${target.workspaceKey}`
        )
      }
      // Why: mixed host ownership cannot safely choose a provider inventory.
      targetJobs.push({ kind: 'runtime', target })
      continue
    }
    let sharedProvider = sharedProviders.get(provider)
    if (!sharedProvider) {
      sharedProvider = createSharedFolderWorkspaceTeardownProvider(provider)
      sharedProviders.set(provider, sharedProvider)
    }
    if (requiresPhysicalStop(target, deps)) {
      sharedProvider.requirePhysicalStop = true
    }
    targetJobs.push({ kind: 'provider', target, ...sharedProvider })
  }
  const inventoryJobs: InventoryJob[] = [...sharedProviders.values()].map(
    ({ markInventoryReady, provider, requirePhysicalStop }) => ({
      kind: 'inventory',
      markReady: markInventoryReady,
      provider,
      requirePhysicalStop
    })
  )
  const inventoryPhaseDeadline =
    inventoryJobs.length > 0
      ? batchStartedAt + Math.floor(FOLDER_WORKSPACE_TEARDOWN_TIMEOUT_MS / 2)
      : batchStartedAt
  const inventoryResults = await mapSettledWithConcurrency(
    inventoryJobs,
    FOLDER_WORKSPACE_TEARDOWN_CONCURRENCY,
    (job, index) => {
      const deadline = getFolderWorkspaceTeardownJobDeadline(
        batchStartedAt,
        inventoryPhaseDeadline,
        inventoryJobs.length,
        index
      )
      return inventoryFolderWorkspaceProvider(
        job.provider,
        deadline,
        job.markReady,
        job.requirePhysicalStop
      )
    }
  )
  const failedInventory = inventoryResults.find((result) => result.status === 'rejected')
  if (failedInventory) {
    throw failedInventory.reason
  }
  const targetResults = await mapSettledWithConcurrency(
    targetJobs,
    FOLDER_WORKSPACE_TEARDOWN_CONCURRENCY,
    (job, index) => {
      const deadline = getFolderWorkspaceTeardownJobDeadline(
        inventoryPhaseDeadline,
        batchDeadline,
        targetJobs.length,
        index
      )
      return job.kind === 'provider'
        ? stopProviderFolderWorkspaceTerminals(
            job.target,
            job.provider,
            job.inventoryReady,
            deadline,
            deps
          )
        : stopRuntimeFolderWorkspaceTerminals(job.target, deadline, deps)
    }
  )
  const failed = targetResults.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }
  const completed = [...inventoryResults, ...targetResults].filter(
    (result): result is PromiseFulfilledResult<WorktreeTeardownResult> =>
      result.status === 'fulfilled'
  )
  return completed.reduce<WorktreeTeardownResult>(
    (total, result) => ({
      runtimeStopped: total.runtimeStopped + result.value.runtimeStopped,
      providerStopped: total.providerStopped + result.value.providerStopped,
      registryStopped: total.registryStopped + result.value.registryStopped
    }),
    emptyTeardownResult()
  )
}

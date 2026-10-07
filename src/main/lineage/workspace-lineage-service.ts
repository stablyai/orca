import path from 'node:path'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import { isWorkspaceKey } from '../../shared/workspace-scope'
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'
import type {
  AttachToParentArgs,
  AttachToParentResult,
  NotifyWorktreeCreatedArgs,
  NotifyWorktreeCreatedResult
} from '../../shared/fleet-lineage-types'
import { getActiveLineageContext } from './pty-env-injector'
import type { PatternRepo } from './lineage-name-pattern-discovery'
import type { ManualPullRequestLink } from '../../shared/lineage-discovery-types'

export type LineageStoreContract = {
  getAllWorkspaceLineage?(): Record<string, WorkspaceLineage>
  getWorkspaceLineage?(childWorkspaceKey: string): WorkspaceLineage | undefined
  setWorkspaceLineage?(lineage: WorkspaceLineage): WorkspaceLineage
  getState?(): { workspaceLineageByChildKey?: Record<string, WorkspaceLineage> }
  getRepos?(): PatternRepo[]
  getWorktree?(id: string): { path?: string; repoId?: string; branch?: string } | undefined
  getFolderWorkspace?(id: string): { name: string } | undefined
  getSettings?(): { lineageDiscovery?: unknown }
  getLineageManualLinks?(parentKey: string): ManualPullRequestLink[]
  setLineageManualLinks?(parentKey: string, links: ManualPullRequestLink[]): void
}

function getStoredLineages(store: LineageStoreContract): Record<string, WorkspaceLineage> {
  if (typeof store.getAllWorkspaceLineage === 'function') {
    return store.getAllWorkspaceLineage() || {}
  }
  if (typeof store.getState === 'function') {
    return store.getState()?.workspaceLineageByChildKey || {}
  }
  return {}
}

export function attachWorkspaceToParent(
  store: LineageStoreContract,
  args: AttachToParentArgs
): AttachToParentResult {
  try {
    const { parentWorkspaceKey, childWorkspaceKey } = args
    if (!parentWorkspaceKey || !childWorkspaceKey) {
      return {
        status: 400,
        success: false,
        error: 'Parent and child workspace keys are required'
      }
    }

    if (!isWorkspaceKey(parentWorkspaceKey) || !isWorkspaceKey(childWorkspaceKey)) {
      return {
        status: 400,
        success: false,
        error: 'Parent and child must be valid workspace keys'
      }
    }

    const lineages = getStoredLineages(store)
    const existing = lineages[childWorkspaceKey] ?? store.getWorkspaceLineage?.(childWorkspaceKey)

    // Idempotency: if already registered with the same parent, return existing entry
    if (existing && existing.parentWorkspaceKey === parentWorkspaceKey) {
      return {
        status: 200,
        success: true,
        lineageEntry: existing
      }
    }

    const lineageEntry: WorkspaceLineage = {
      childWorkspaceKey,
      childInstanceId: existing?.childInstanceId ?? `inst-${Date.now()}`,
      parentWorkspaceKey,
      parentInstanceId: null,
      origin: 'manual',
      capture: {
        source: 'manual-action',
        confidence: 'explicit'
      },
      createdAt: existing?.createdAt ?? Date.now()
    }

    if (typeof store.setWorkspaceLineage === 'function') {
      const saved = store.setWorkspaceLineage(lineageEntry)
      return {
        status: 200,
        success: true,
        lineageEntry: saved || lineageEntry
      }
    }

    // Fallback if direct state mutation is needed
    if (typeof store.getState === 'function') {
      const state = store.getState()
      if (state && !state.workspaceLineageByChildKey) {
        state.workspaceLineageByChildKey = {}
      }
      if (state?.workspaceLineageByChildKey) {
        state.workspaceLineageByChildKey[childWorkspaceKey] = lineageEntry
        return {
          status: 200,
          success: true,
          lineageEntry
        }
      }
    }

    return {
      status: 500,
      success: false,
      error: 'Store does not support setWorkspaceLineage'
    }
  } catch (error) {
    return {
      status: 500,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function notifyWorktreeCreated(
  store: LineageStoreContract,
  args: NotifyWorktreeCreatedArgs
): NotifyWorktreeCreatedResult {
  try {
    const { worktreePath, repoName, branch } = args
    if (!worktreePath || typeof worktreePath !== 'string' || worktreePath.trim().length === 0) {
      return {
        status: 400,
        registered: false,
        error: 'worktreePath is required'
      }
    }

    const parentWorkspaceKey =
      args.parentWorkspaceKey ??
      getActiveLineageContext()?.parentWorkspaceKey ??
      process.env.ORCA_PARENT_WORKSPACE_KEY
    if (!parentWorkspaceKey) {
      return {
        status: 400,
        registered: false,
        error: 'No active parent workspace found'
      }
    }

    if (!isWorkspaceKey(parentWorkspaceKey)) {
      return {
        status: 400,
        registered: false,
        error: 'Parent must be a valid workspace key'
      }
    }

    // Build child workspace key: worktree:<repoName>:<branch> or worktree:<worktreePath>
    const normalizedPath = path.resolve(worktreePath)
    let childKey: WorkspaceKey
    if (repoName && branch) {
      childKey = `worktree:${repoName}:${branch}`
    } else if (repoName) {
      childKey = `worktree:${repoName}::${normalizedPath}`
    } else {
      const baseName = path.basename(normalizedPath)
      childKey = `worktree:${baseName}`
    }

    const lineages = getStoredLineages(store)
    const existing = lineages[childKey] ?? store.getWorkspaceLineage?.(childKey)

    if (existing && existing.parentWorkspaceKey === parentWorkspaceKey) {
      return {
        status: 200,
        registered: true,
        lineageEntry: existing
      }
    }

    const lineageEntry: WorkspaceLineage = {
      childWorkspaceKey: childKey,
      childInstanceId: existing?.childInstanceId ?? `inst-${Date.now()}`,
      parentWorkspaceKey,
      parentInstanceId: null,
      origin: 'cli',
      capture: {
        source: 'cwd-context',
        confidence: 'inferred'
      },
      createdAt: existing?.createdAt ?? Date.now()
    }

    if (typeof store.setWorkspaceLineage === 'function') {
      const saved = store.setWorkspaceLineage(lineageEntry)
      return {
        status: 200,
        registered: true,
        lineageEntry: saved || lineageEntry
      }
    }

    if (typeof store.getState === 'function') {
      const state = store.getState()
      if (state && !state.workspaceLineageByChildKey) {
        state.workspaceLineageByChildKey = {}
      }
      if (state?.workspaceLineageByChildKey) {
        state.workspaceLineageByChildKey[childKey] = lineageEntry
        return {
          status: 200,
          registered: true,
          lineageEntry
        }
      }
    }

    return {
      status: 500,
      registered: false,
      error: 'Store does not support setWorkspaceLineage'
    }
  } catch (error) {
    return {
      status: 500,
      registered: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function getLineageChildrenForParent(
  store: LineageStoreContract,
  parentWorkspaceKey: string
): WorkspaceLineage[] {
  const lineages = getStoredLineages(store)
  return Object.values(lineages).filter(
    (lineage) => lineage && lineage.parentWorkspaceKey === parentWorkspaceKey
  )
}

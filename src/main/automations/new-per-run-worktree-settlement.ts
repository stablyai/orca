import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { AutomationWorkspaceProvenance } from '../../shared/worktree/types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import {
  automationRunWorkspaceStatus,
  resolveAutomationWorktreeRetention,
  selectAutomationWorktreesToReclaim,
  type AutomationWorktreeRetentionCandidate
} from '../../shared/automation-worktree-retention'
import { inspectAutomationWorktreeGitSafety } from './automation-worktree-reclaim-safety'

export type NewPerRunWorktreeSettlement = {
  settle(run: AutomationRun): Promise<void>
}

type ListedAutomationWorktree = {
  id: string
  path: string
  hostId?: string
  isMainWorktree: boolean
  baseRef?: string
  automationProvenance?: AutomationWorkspaceProvenance
}

type SettlementStore = {
  listAutomations(): Automation[]
  listAutomationRuns(automationId?: string): AutomationRun[]
  getRepo(id: string): Repo | undefined
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  getWorktreeMetaForHost?(
    worktreeId: string,
    executionHostId: ExecutionHostId
  ): WorktreeMeta | undefined
  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): WorktreeMeta
  setWorktreeMetaForHost?(
    worktreeId: string,
    executionHostId: ExecutionHostId,
    meta: Partial<WorktreeMeta>
  ): WorktreeMeta
}

type SettlementRuntime = {
  listManagedWorktrees(
    repoSelector?: string,
    limit?: number
  ): Promise<{ worktrees: ListedAutomationWorktree[]; truncated: boolean }>
  removeManagedWorktree(
    worktreeSelector: string,
    options?: { hostId?: string; force?: boolean; runHooks?: boolean }
  ): Promise<unknown>
}

type SettlementDeps = {
  store: SettlementStore
  runtime: SettlementRuntime
  localGitOptionsForRepo?: (repo: Repo) => { wslDistro?: string }
  inspectGitSafety?: typeof inspectAutomationWorktreeGitSafety
}

const LIST_LIMIT = 1000

function ownedProvenance(
  provenance: AutomationWorkspaceProvenance | undefined,
  automationId: string
): AutomationWorkspaceProvenance | undefined {
  if (provenance?.kind === 'created-by-automation' && provenance.automationId === automationId) {
    return provenance
  }
  return undefined
}

function readExistingMeta(
  store: SettlementStore,
  worktreeId: string,
  hostId: string | undefined
): WorktreeMeta | undefined {
  const host = parseExecutionHostId(hostId)
  if (host && store.getWorktreeMetaForHost) {
    const qualified = store.getWorktreeMetaForHost(worktreeId, host.id)
    if (qualified) {
      return qualified
    }
  }
  const legacy = store.getAllWorktreeMeta()[worktreeId]
  if (!legacy || (host && legacy.hostId && legacy.hostId !== host.id)) {
    return undefined
  }
  return legacy
}

function writeWorkspaceStatus(
  store: SettlementStore,
  worktreeId: string,
  hostId: string | undefined,
  workspaceStatus: 'completed' | 'failed'
): void {
  const host = parseExecutionHostId(hostId)
  if (host && store.setWorktreeMetaForHost) {
    store.setWorktreeMetaForHost(worktreeId, host.id, { workspaceStatus })
    return
  }
  store.setWorktreeMeta(worktreeId, { workspaceStatus })
}

export function createNewPerRunWorktreeSettlement(
  deps: SettlementDeps
): NewPerRunWorktreeSettlement {
  return {
    async settle(run): Promise<void> {
      if ((run.status !== 'completed' && run.status !== 'dispatch_failed') || !run.workspaceId) {
        return
      }
      try {
        const automation = deps.store
          .listAutomations()
          .find((entry) => entry.id === run.automationId)
        if (!automation || automation.workspaceMode !== 'new_per_run') {
          return
        }
        await settleOwnedWorktrees(deps, automation, run)
      } catch (error) {
        console.error('[automations] new-per-run worktree settlement failed:', error)
      }
    }
  }
}

async function settleOwnedWorktrees(
  deps: SettlementDeps,
  automation: Automation,
  run: AutomationRun
): Promise<void> {
  if (!run.workspaceId || (run.status !== 'completed' && run.status !== 'dispatch_failed')) {
    return
  }
  const repo = deps.store.getRepo(automation.projectId)
  const listed = await listRepoWorktrees(deps.runtime, automation.projectId)
  const listedById = new Map(listed.worktrees.map((worktree) => [worktree.id, worktree]))
  const rows = collectOwnedRows(deps.store, automation.id, listed.worktrees)
  const finished = rows.get(run.workspaceId)
  const finishedProvenance = ownedProvenance(
    finished?.meta?.automationProvenance ?? finished?.listed?.automationProvenance,
    automation.id
  )
  if (!finished || finishedProvenance?.automationRunId !== run.id) {
    return
  }
  const statusHostId = finished.listed?.hostId ?? finished.meta?.hostId ?? finishedProvenance.hostId
  if (readExistingMeta(deps.store, run.workspaceId, statusHostId)) {
    writeWorkspaceStatus(
      deps.store,
      run.workspaceId,
      statusHostId,
      automationRunWorkspaceStatus(run.status)
    )
  }
  const candidates: AutomationWorktreeRetentionCandidate[] = []
  for (const [worktreeId, row] of rows) {
    candidates.push(await toCandidate(deps, automation, worktreeId, row, repo))
  }
  const runStatusById = new Map(
    deps.store.listAutomationRuns(automation.id).map((entry) => [entry.id, entry.status])
  )
  const removeIds = selectAutomationWorktreesToReclaim({
    policy: resolveAutomationWorktreeRetention(
      automation.workspaceMode,
      automation.worktreeRetention
    ),
    listingTruncated: listed.truncated,
    finishedRunId: run.id,
    runStatusById,
    candidates
  })
  for (const worktreeId of removeIds) {
    try {
      await deps.runtime.removeManagedWorktree(`id:${worktreeId}`, {
        hostId: listedById.get(worktreeId)?.hostId,
        force: false,
        runHooks: false
      })
    } catch (error) {
      console.error(`[automations] kept worktree ${worktreeId}; removal refused:`, error)
    }
  }
}

async function listRepoWorktrees(
  runtime: SettlementRuntime,
  projectId: string
): Promise<{ worktrees: ListedAutomationWorktree[]; truncated: boolean }> {
  try {
    return await runtime.listManagedWorktrees(`id:${projectId}`, LIST_LIMIT)
  } catch (error) {
    console.error('[automations] could not list worktrees to settle a finished run:', error)
    return { worktrees: [], truncated: true }
  }
}

function collectOwnedRows(
  store: SettlementStore,
  automationId: string,
  listed: readonly ListedAutomationWorktree[]
): Map<string, { meta?: WorktreeMeta; listed?: ListedAutomationWorktree }> {
  const rows = new Map<string, { meta?: WorktreeMeta; listed?: ListedAutomationWorktree }>()
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (ownedProvenance(meta.automationProvenance, automationId)) {
      rows.set(worktreeId, { meta })
    }
  }
  for (const worktree of listed) {
    if (!ownedProvenance(worktree.automationProvenance, automationId)) {
      continue
    }
    const current = rows.get(worktree.id)
    rows.set(worktree.id, { meta: current?.meta, listed: worktree })
  }
  return rows
}

async function toCandidate(
  deps: SettlementDeps,
  automation: Automation,
  worktreeId: string,
  row: { meta?: WorktreeMeta; listed?: ListedAutomationWorktree },
  repo: Repo | undefined
): Promise<AutomationWorktreeRetentionCandidate> {
  const provenance = ownedProvenance(
    row.meta?.automationProvenance ?? row.listed?.automationProvenance,
    automation.id
  )
  const listed = row.listed
  const baseRef = automation.baseBranch ?? listed?.baseRef ?? row.meta?.baseRef ?? null
  const hostId = listed?.hostId ?? row.meta?.hostId ?? provenance?.hostId
  let safety: AutomationWorktreeRetentionCandidate['safety'] = 'unverifiable'
  if (listed?.isMainWorktree) {
    safety = 'keep'
  } else if (listed) {
    try {
      const localGitOptions = repo ? deps.localGitOptionsForRepo?.(repo) : undefined
      safety = await (deps.inspectGitSafety ?? inspectAutomationWorktreeGitSafety)({
        hostId,
        cwd: listed.path,
        baseRef,
        isMainWorktree: false,
        localGitOptions
      })
    } catch {
      safety = 'unverifiable'
    }
  }
  return {
    id: worktreeId,
    createdAt: provenance?.createdAt ?? row.meta?.createdAt ?? 0,
    automationRunId: provenance?.automationRunId ?? '',
    isMainWorktree: listed?.isMainWorktree === true,
    safety
  }
}

import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../src/shared/runtime-types'
import {
  syncUnreadWorktreeForTabStatus,
  toReconciledStatus,
  type ReconciledTerminalAgentStatus
} from './catalog-worktree-unread-status'

export { buildTabCompletionKeys, resolveTrackedTabCompletionState } from './tab-completion-state'
export { syncUnreadWorktreeForTabStatus, type ReconciledTerminalAgentStatus }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type RecentCardWorktree = {
  worktreeId: string
  displayName?: string
  isArchived?: boolean
}

export function recentCardWorktrees(rows: readonly unknown[] | undefined): RecentCardWorktree[] {
  if (rows) {
    setCatalogWorktreesForTabStatus(rows)
  }
  return (rows ?? []).flatMap((row) =>
    isRecord(row) && typeof row.worktreeId === 'string' && row.worktreeId.length > 0
      ? [
          {
            worktreeId: row.worktreeId,
            displayName: typeof row.displayName === 'string' ? row.displayName : undefined,
            isArchived: typeof row.isArchived === 'boolean' ? row.isArchived : undefined
          }
        ]
      : []
  )
}

export function isUnpublishedSnapshot(snapshot: unknown): boolean {
  return isRecord(snapshot) && snapshot.publicationEpoch === UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
}

let catalogWorktrees: readonly unknown[] | undefined
let catalogReceivedAt = 0
let catalogAgentSignature = ''
const catalogListeners = new Set<() => void>()

function computeCatalogAgentSignature(worktrees: readonly unknown[] | undefined): string {
  if (!worktrees || worktrees.length === 0) {
    return ''
  }
  const parts: string[] = []
  for (const wt of worktrees) {
    if (!isRecord(wt) || !Array.isArray(wt.agents)) {
      continue
    }
    const wtId =
      typeof wt.worktreeId === 'string' ? wt.worktreeId : typeof wt.id === 'string' ? wt.id : ''
    for (const row of wt.agents) {
      if (!isRecord(row) || typeof row.paneKey !== 'string') {
        continue
      }
      parts.push(
        `${wtId}:${row.paneKey}:${String(row.state ?? '')}:${String(row.workingMode ?? '')}:${String(row.updatedAt ?? '')}:${String(row.stateStartedAt ?? '')}:${String(row.interrupted ?? '')}`
      )
    }
  }
  return parts.join('|')
}

export function setCatalogWorktreesForTabStatus(
  worktrees: readonly unknown[] | null | undefined,
  receivedAt = Date.now()
): void {
  const next = worktrees ?? undefined
  if (next) {
    for (const worktree of next) {
      syncUnreadWorktreeForTabStatus(worktree, receivedAt)
    }
  }
  const nextSig = computeCatalogAgentSignature(next)
  catalogWorktrees = next
  catalogReceivedAt = receivedAt
  if (nextSig !== catalogAgentSignature) {
    catalogAgentSignature = nextSig
    catalogListeners.forEach((listener) => listener())
  }
}

export function getCatalogWorktreesForTabStatus(): readonly unknown[] | undefined {
  return catalogWorktrees
}

export function subscribeCatalogWorktreesForTabStatus(listener: () => void): () => void {
  catalogListeners.add(listener)
  return () => {
    catalogListeners.delete(listener)
  }
}

export function clearCatalogWorktreesForTabStatusForTests(): void {
  catalogWorktrees = undefined
  catalogReceivedAt = 0
  catalogAgentSignature = ''
  catalogListeners.clear()
}

function findCatalogAgentRow(
  worktrees: readonly unknown[] | undefined,
  worktreeId: string | undefined,
  paneKey: string | null
): Record<string, unknown> | null {
  if (!worktrees || !paneKey) {
    return null
  }
  for (const wt of worktrees) {
    if (!isRecord(wt) || !Array.isArray(wt.agents)) {
      continue
    }
    if (worktreeId) {
      const wtId =
        typeof wt.worktreeId === 'string' ? wt.worktreeId : typeof wt.id === 'string' ? wt.id : null
      if (wtId !== worktreeId) {
        continue
      }
    }
    for (const row of wt.agents) {
      if (isRecord(row) && row.paneKey === paneKey) {
        return row
      }
    }
  }
  return null
}

export function reconcileTerminalAgentStatusWithCatalog(
  raw: unknown,
  options?: {
    worktreeId?: string
    worktrees?: readonly unknown[]
    tabId?: string | null
    parentTabId?: string | null
    leafId?: string | null
    now?: number
  }
): ReconciledTerminalAgentStatus | null {
  const rawObj = isRecord(raw) ? raw : null
  if (rawObj?.restoredUnconfirmed === true) {
    return toReconciledStatus(rawObj)
  }
  const worktrees = options?.worktrees ?? catalogWorktrees
  const promptEmpty = !rawObj || rawObj.prompt === ''
  if (promptEmpty && worktrees && worktrees.length > 0) {
    const paneKey =
      (rawObj && typeof rawObj.paneKey === 'string' && rawObj.paneKey) ||
      (typeof options?.parentTabId === 'string' && typeof options?.leafId === 'string'
        ? `${options.parentTabId}:${options.leafId}`
        : null) ||
      (typeof options?.tabId === 'string' && options.tabId.includes('::')
        ? options.tabId.replace('::', ':')
        : null)
    const catalogRow = findCatalogAgentRow(worktrees, options?.worktreeId, paneKey)
    if (catalogRow && typeof catalogRow.updatedAt === 'number') {
      const rawUpdatedAt =
        rawObj && typeof rawObj.updatedAt === 'number' ? rawObj.updatedAt : -Infinity
      const rawStateStartedAt =
        rawObj && typeof rawObj.stateStartedAt === 'number' ? rawObj.stateStartedAt : undefined
      const rawEffectiveUpdatedAt = Math.max(rawUpdatedAt, rawStateStartedAt ?? -Infinity)
      const catalogStateStartedAt =
        typeof catalogRow.stateStartedAt === 'number' ? catalogRow.stateStartedAt : undefined
      const predatesStart =
        rawStateStartedAt !== undefined &&
        catalogRow.updatedAt < rawStateStartedAt &&
        (catalogStateStartedAt === undefined || catalogStateStartedAt < rawStateStartedAt)
      const hasCompletedTurnEvidence =
        rawObj?.state === 'done' &&
        (typeof rawObj.lastAssistantMessage === 'string' || rawObj.interrupted === true)
      const catalogStartsNewerTurn =
        catalogStateStartedAt !== undefined &&
        rawStateStartedAt !== undefined &&
        catalogStateStartedAt > rawStateStartedAt &&
        catalogRow.updatedAt > rawEffectiveUpdatedAt
      const staleLiveQuestionOrPermission =
        rawObj?.state === 'done' &&
        !options?.worktrees &&
        (catalogRow.state === 'waiting' || catalogRow.state === 'blocked')
      const isShellMaskedWorkingTurn =
        rawObj?.state === 'done' &&
        !hasCompletedTurnEvidence &&
        catalogRow.state === 'working' &&
        rawStateStartedAt !== undefined &&
        catalogStateStartedAt === rawStateStartedAt &&
        rawUpdatedAt > rawStateStartedAt
      if (
        !predatesStart &&
        !staleLiveQuestionOrPermission &&
        (!hasCompletedTurnEvidence || catalogStartsNewerTurn) &&
        (catalogRow.updatedAt >= rawEffectiveUpdatedAt || isShellMaskedWorkingTurn)
      ) {
        const merged = rawObj ? { ...rawObj, ...catalogRow } : catalogRow
        return toReconciledStatus(merged, options?.now ?? (catalogReceivedAt || Date.now()))
      }
    }
  }
  return rawObj ? toReconciledStatus(rawObj) : null
}

import { isPtyIncarnationId, type PtyIncarnationId } from '../../../shared/pty-incarnation'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { LegacyWorkerTerminalRecoveryRow } from './types'

export type LegacyWorkerTerminalRecoveryCandidate = {
  dispatchId: string
  dispatchStatus: LegacyWorkerTerminalRecoveryRow['dispatch_status']
  contractVersion: number
  taskId: string
  worktreeId: string
  terminalHandle: string
  paneKey: string
  tabId: string
  leafId: string
  processIncarnation: string
  ptyId: string
  incarnationId: PtyIncarnationId
}

export type LegacyWorkerTerminalRecoveryPlan = {
  blockedPanes: { worktreeId: string; paneKey: string; contractVersion: number }[]
  candidates: LegacyWorkerTerminalRecoveryCandidate[]
  ambiguousDispatchIds: string[]
}

function parseProcessIncarnation(
  value: string
): { ptyId: string; incarnationId: PtyIncarnationId } | null {
  const separator = value.lastIndexOf(':')
  if (separator <= 0) {
    return null
  }
  const ptyId = value.slice(0, separator)
  const incarnationId = value.slice(separator + 1)
  return ptyId && isPtyIncarnationId(incarnationId) ? { ptyId, incarnationId } : null
}

function countCandidateKeys(
  candidates: readonly LegacyWorkerTerminalRecoveryCandidate[],
  select: (candidate: LegacyWorkerTerminalRecoveryCandidate) => string
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    const key = select(candidate)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function planLegacyWorkerTerminalRecovery(
  rows: readonly LegacyWorkerTerminalRecoveryRow[]
): LegacyWorkerTerminalRecoveryPlan {
  const blockedPanes = new Map<
    string,
    { worktreeId: string; paneKey: string; contractVersion: number }
  >()
  const parsedCandidates: LegacyWorkerTerminalRecoveryCandidate[] = []
  for (const row of rows) {
    const worktreeId = row.worktree_id?.trim()
    const paneKey = row.assignee_pane_key?.trim()
    const pane = paneKey ? parsePaneKey(paneKey) : null
    if (worktreeId && paneKey && pane) {
      blockedPanes.set(`${worktreeId}\0${paneKey}`, {
        worktreeId,
        paneKey,
        contractVersion: row.contract_version
      })
    }
    const terminalHandle = row.assignee_handle?.trim()
    const workerHandle = row.agent_terminal_handle?.trim()
    const processIncarnation = row.process_incarnation?.trim()
    const process = processIncarnation ? parseProcessIncarnation(processIncarnation) : null
    if (
      !worktreeId ||
      !paneKey ||
      !pane ||
      !terminalHandle ||
      terminalHandle !== workerHandle ||
      !processIncarnation ||
      !process
    ) {
      continue
    }
    parsedCandidates.push({
      dispatchId: row.dispatch_id,
      dispatchStatus: row.dispatch_status,
      contractVersion: row.contract_version,
      taskId: row.task_id,
      worktreeId,
      terminalHandle,
      paneKey,
      tabId: pane.tabId,
      leafId: pane.leafId,
      processIncarnation,
      ptyId: process.ptyId,
      incarnationId: process.incarnationId
    })
  }

  const identityCounts = [
    countCandidateKeys(parsedCandidates, (candidate) => candidate.terminalHandle),
    countCandidateKeys(parsedCandidates, (candidate) => candidate.paneKey),
    countCandidateKeys(parsedCandidates, (candidate) => candidate.processIncarnation)
  ]
  const ambiguousDispatchIds = new Set<string>()
  const candidates = parsedCandidates.filter((candidate) => {
    const keys = [candidate.terminalHandle, candidate.paneKey, candidate.processIncarnation]
    const ambiguous = keys.some((key, index) => (identityCounts[index]?.get(key) ?? 0) !== 1)
    if (ambiguous) {
      ambiguousDispatchIds.add(candidate.dispatchId)
    }
    return !ambiguous
  })
  return {
    blockedPanes: [...blockedPanes.values()],
    candidates,
    ambiguousDispatchIds: [...ambiguousDispatchIds]
  }
}

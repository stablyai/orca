import type { MaestroBrowserSurfaceReceipt } from '../../../../shared/maestro-browser-surface'
import type { ProjectedAgentNode } from '../../../../shared/maestro-projection'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'

export type MaestroWorkspaceLinkReceiptEndpoint = {
  surfaceKey: string
  receipt: MaestroTerminalLease | MaestroBrowserSurfaceReceipt
  node: ProjectedAgentNode
}

export function joinMaestroWorkspaceBrowserReceipts(
  source: MaestroWorkspaceLinkReceiptEndpoint,
  target: MaestroWorkspaceLinkReceiptEndpoint
): { terminal: MaestroTerminalLease; browser: MaestroBrowserSurfaceReceipt } | null {
  const terminal =
    'launchProfile' in source.receipt
      ? source.receipt
      : 'launchProfile' in target.receipt
        ? target.receipt
        : null
  const browser =
    'protocol' in source.receipt
      ? source.receipt
      : 'protocol' in target.receipt
        ? target.receipt
        : null
  if (
    !terminal ||
    !browser ||
    terminal.runId !== browser.run_id ||
    terminal.taskId !== browser.task_id ||
    terminal.attemptId !== browser.attempt_id ||
    terminal.launchProfile.agent !== browser.agent_id
  ) {
    return null
  }
  return { terminal, browser }
}

export function joinMaestroWorkspaceParentChildReceipts(
  source: MaestroWorkspaceLinkReceiptEndpoint,
  target: MaestroWorkspaceLinkReceiptEndpoint,
  runId: string
): { child: MaestroTerminalLease; parent: MaestroTerminalLease } | null {
  if (
    !('launchProfile' in source.receipt) ||
    !('launchProfile' in target.receipt) ||
    source.node.type !== 'attempt' ||
    target.node.type !== 'attempt' ||
    !source.node.attemptId ||
    !target.node.attemptId
  ) {
    return null
  }
  const child = source.receipt
  const parent = target.receipt
  const parentAttemptMatches =
    parent.attemptId === target.node.attemptId ||
    (parent.role === 'coordinator' &&
      parent.coordinatorGeneration !== null &&
      child.coordinatorGeneration === parent.coordinatorGeneration &&
      child.spawnedBy === `coordinator:g${parent.coordinatorGeneration}`)
  if (
    child.runId !== runId ||
    parent.runId !== runId ||
    child.attemptId !== source.node.attemptId ||
    !parentAttemptMatches
  ) {
    return null
  }
  return { child, parent }
}

function receiptTimestamp(value: string): string {
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
}

export function latestMaestroWorkspaceReceiptTimestamp(values: string[]): string {
  return values.map(receiptTimestamp).sort().at(-1)!
}

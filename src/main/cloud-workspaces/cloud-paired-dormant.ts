// A paired cloud server (GitHub-only, or opened on another computer) has no VM record here, so the
// recipe-VM sleep check never stopped Orca dialing it. While its control plane says the sandbox is
// asleep or archived nothing answers: every background reconnect and health probe failed, cycling
// the connection between disconnected and connecting. The last status read marks the bound servers
// dormant; a wake or unarchive clears the mark before it reconnects, as does any later read that
// says the sandbox is running (woken from another computer).
import type { HostedWorkspaceStatus } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { cloudPairedSandboxesByEnvironment } from './cloud-paired-environment-ids'

type DormantStatusFacts = Pick<HostedWorkspaceStatus, 'state' | 'archive'>

const dormantSandboxIds = new Set<string>()

function isDormantCloudStatus(status: DormantStatusFacts): boolean {
  return (
    status.state === 'sleeping' ||
    status.state === 'stopping' ||
    status.state === 'archived' ||
    status.archive !== null
  )
}

/** Records what a status read said about a paired sandbox. */
export function notePairedCloudSandboxStatus(sandboxId: string, status: DormantStatusFacts): void {
  if (isDormantCloudStatus(status)) {
    dormantSandboxIds.add(sandboxId)
  } else {
    dormantSandboxIds.delete(sandboxId)
  }
}

/** A status read of a workspace's sandbox; owned rows are suspended through their VM record. */
export function notePairedCloudStatusRead(
  found: { sandboxId: string; owned: unknown },
  status: DormantStatusFacts
): void {
  if (!found.owned) {
    notePairedCloudSandboxStatus(found.sandboxId, status)
  }
}

/** A wake or unarchive is about to reconnect it: background contact may resume. */
export function clearPairedCloudSandboxDormant(sandboxId: string): void {
  dormantSandboxIds.delete(sandboxId)
}

/** Whether the paired server behind this environment must not be dialed in the background. */
export function isPairedCloudEnvironmentDormant(environmentId: string): boolean {
  if (dormantSandboxIds.size === 0) {
    return false
  }
  const sandboxId = cloudPairedSandboxesByEnvironment().get(environmentId)
  return sandboxId !== undefined && dormantSandboxIds.has(sandboxId)
}

export function resetPairedCloudDormant(): void {
  dormantSandboxIds.clear()
}

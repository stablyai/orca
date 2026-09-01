import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import type { AgentSessionOwnershipKey, ResumableTuiAgent } from '../../shared/agent-session-resume'

export type IndexedSnapshotTarget = {
  executionHostId: AgentLaunchExecutionHostId
  platform: NodeJS.Platform
}

export type VaultSnapshotScanIdentity = {
  baseAgent: ResumableTuiAgent
  scannedProviderSessionId: string
  scannedTranscriptPath?: string | null
  scannedExecutionHostId: string
}

export function vaultSessionKeyForRecord(record: {
  worktreeId: string
  baseAgent: ResumableTuiAgent
  providerSession: { id: string }
}): AgentSessionOwnershipKey {
  return {
    worktreeId: record.worktreeId,
    baseAgent: record.baseAgent,
    providerSessionId: record.providerSession.id
  }
}

/** Reference-counted target inventory for the private Vault correlation index. */
export class AgentSessionVaultTargetIndex {
  private readonly targetsByBase = new Map<ResumableTuiAgent, Map<string, number>>()

  clear(): void {
    this.targetsByBase.clear()
  }

  add(baseAgent: ResumableTuiAgent, target: IndexedSnapshotTarget): void {
    const targets = this.targetsByBase.get(baseAgent) ?? new Map<string, number>()
    const key = targetKey(target)
    targets.set(key, (targets.get(key) ?? 0) + 1)
    this.targetsByBase.set(baseAgent, targets)
  }

  remove(baseAgent: ResumableTuiAgent, target: IndexedSnapshotTarget): void {
    const targets = this.targetsByBase.get(baseAgent)
    if (!targets) {
      return
    }
    const key = targetKey(target)
    const count = targets.get(key) ?? 0
    if (count <= 1) {
      targets.delete(key)
    } else {
      targets.set(key, count - 1)
    }
    if (targets.size === 0) {
      this.targetsByBase.delete(baseAgent)
    }
  }

  matching(baseAgent: ResumableTuiAgent, scannedExecutionHostId: string): IndexedSnapshotTarget[] {
    const targets = this.targetsByBase.get(baseAgent)
    if (!targets) {
      return []
    }
    return [...targets.keys()]
      .map((key) => JSON.parse(key) as IndexedSnapshotTarget)
      .filter((target) =>
        targetMatchesDiscoveredHost(target.executionHostId, scannedExecutionHostId)
      )
  }
}

function targetKey(target: IndexedSnapshotTarget): string {
  return JSON.stringify({
    executionHostId: target.executionHostId,
    platform: target.platform
  } satisfies IndexedSnapshotTarget)
}

export function targetMatchesDiscoveredHost(
  targetExecutionHostId: AgentLaunchExecutionHostId,
  scannedExecutionHostId: string
): boolean {
  if (scannedExecutionHostId === 'local') {
    return targetExecutionHostId === 'local' || targetExecutionHostId.startsWith('wsl:')
  }
  return targetExecutionHostId === scannedExecutionHostId
}

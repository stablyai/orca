import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import { reconcileLegacyWorkerCandidate } from './runtime-legacy-worker-terminal-recovery-candidate'
import type {
  LegacyWorkerRecoveryOptions,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution,
  LegacyWorkerRecoveryWorkspace,
  LegacyWorkerTerminalRecoveryResult
} from './runtime-legacy-worker-terminal-recovery-types'

export async function runLegacyWorkerTerminalRecovery(
  controller: RuntimeLegacyWorkerTerminalRecoveryController,
  ports: LegacyWorkerRecoveryPorts,
  options: LegacyWorkerRecoveryOptions
): Promise<LegacyWorkerTerminalRecoveryResult> {
  const plan = ports.preparePlan()
  const adoptedDispatchIds: string[] = []
  const exitedDispatchIds: string[] = []
  const deferredDispatchIds = new Set(plan.ambiguousDispatchIds)
  const pendingResolutions: LegacyWorkerRecoveryResolution[] = []
  const providers = new Map<
    string,
    {
      connectionId: string | null
      entries: {
        candidate: (typeof plan.candidates)[number]
        workspace: LegacyWorkerRecoveryWorkspace
      }[]
    }
  >()
  for (const candidate of plan.candidates) {
    try {
      const workspace = await ports.resolveWorkspace(candidate)
      const sshPty = parseAppSshPtyId(candidate.ptyId)
      if (workspace.scope.connectionId) {
        if (
          options.connectionId !== workspace.scope.connectionId ||
          sshPty?.connectionId !== workspace.scope.connectionId
        ) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
      } else if (
        options.connectionId !== undefined ||
        sshPty !== null ||
        !ports.canRecoverPersistentLocalPtys()
      ) {
        deferredDispatchIds.add(candidate.dispatchId)
        continue
      }
      const connectionId = workspace.scope.connectionId
      const providerKey = connectionId === null ? 'local' : `ssh:${connectionId}`
      const provider = providers.get(providerKey) ?? { connectionId, entries: [] }
      provider.entries.push({ candidate, workspace })
      providers.set(providerKey, provider)
    } catch {
      deferredDispatchIds.add(candidate.dispatchId)
    }
  }
  for (const provider of providers.values()) {
    const resolvedWorktrees = [
      ...new Map(
        provider.entries.map(({ workspace }) => [workspace.resolved.id, workspace.resolved])
      ).values()
    ]
    const inventory = await ports.refreshInventory(resolvedWorktrees, provider.connectionId)
    if (!inventory) {
      provider.entries.forEach(({ candidate }) => deferredDispatchIds.add(candidate.dispatchId))
      continue
    }
    for (const { candidate, workspace } of provider.entries) {
      await reconcileLegacyWorkerCandidate({
        controller,
        ports,
        options,
        candidate,
        workspace,
        resolvedWorktrees,
        inventory,
        deferredDispatchIds,
        pendingResolutions
      })
    }
  }
  const persistedDispatchIds = await ports.persist(pendingResolutions)
  for (const { candidate, resolution } of pendingResolutions) {
    if (!persistedDispatchIds.has(candidate.dispatchId)) {
      deferredDispatchIds.add(candidate.dispatchId)
      continue
    }
    if (resolution === 'adopted') {
      controller.addRecoveredPty(candidate.ptyId)
      ports.notifyResolution(candidate, 'adopted')
      adoptedDispatchIds.push(candidate.dispatchId)
      continue
    }
    ports.rollback(candidate)
    if (!ports.reconcileMissing(candidate)) {
      deferredDispatchIds.add(candidate.dispatchId)
      continue
    }
    ports.notifyResolution(candidate, 'exited')
    exitedDispatchIds.push(candidate.dispatchId)
  }
  const result = {
    blockedPaneCount: plan.blockedPanes.length,
    adoptedDispatchIds,
    exitedDispatchIds,
    deferredDispatchIds: [...deferredDispatchIds]
  }
  ports.updateRetry(plan, deferredDispatchIds, options)
  // Why: releases may only finish after the owning provider's terminals are rediscovered.
  void ports.reconcileRequestedReleases().catch((error) => {
    console.warn('[orchestration] worker terminal release reconciliation failed', { error })
  })
  return result
}

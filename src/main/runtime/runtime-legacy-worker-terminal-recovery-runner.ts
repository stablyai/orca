import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import type { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import {
  isAbsentLegacyWorkerTerminalProvenExited,
  reconcileLegacyWorkerCandidate
} from './runtime-legacy-worker-terminal-recovery-candidate'
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
  const plan =
    options.retry && options.dispatchIds
      ? ports.preparePlan(options.dispatchIds)
      : ports.preparePlan()
  const retryDispatchIds =
    options.retry && options.dispatchIds ? new Set(options.dispatchIds) : null
  const adoptedDispatchIds: string[] = []
  const exitedDispatchIds: string[] = []
  const deferredDispatchIds = new Set(plan.ambiguousDispatchIds)
  const pendingResolutions: LegacyWorkerRecoveryResolution[] = []
  const workspaceById = new Map<string, Promise<LegacyWorkerRecoveryWorkspace>>()
  const providers = new Map<
    string,
    {
      connectionId: string | null
      entries: {
        candidate: (typeof plan.candidates)[number]
        workspace: LegacyWorkerRecoveryWorkspace | null
      }[]
    }
  >()
  for (const candidate of plan.candidates) {
    if (retryDispatchIds && !retryDispatchIds.has(candidate.dispatchId)) {
      continue
    }
    const sshPty = parseAppSshPtyId(candidate.ptyId)
    const ptyHost = getPtyExecutionHost(candidate.ptyId)
    if (
      ptyHost === 'foreign' ||
      (ptyHost !== null && !sshPty) ||
      (sshPty?.connectionId ?? undefined) !== options.connectionId ||
      (!sshPty && !ports.canRecoverPersistentLocalPtys())
    ) {
      deferredDispatchIds.add(candidate.dispatchId)
      continue
    }
    try {
      let resolution = workspaceById.get(candidate.worktreeId)
      if (!resolution) {
        resolution = ports.resolveWorkspace(candidate)
        workspaceById.set(candidate.worktreeId, resolution)
      }
      const workspace = await resolution
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
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'selector_not_found') {
        const connectionId = sshPty?.connectionId ?? null
        const providerKey = connectionId === null ? 'local' : `ssh:${connectionId}`
        const provider = providers.get(providerKey) ?? { connectionId, entries: [] }
        provider.entries.push({ candidate, workspace: null })
        providers.set(providerKey, provider)
      } else {
        deferredDispatchIds.add(candidate.dispatchId)
      }
    }
  }
  for (const provider of providers.values()) {
    const resolvedWorktrees = [
      ...new Map(
        provider.entries.flatMap(({ workspace }) =>
          workspace ? [[workspace.resolved.id, workspace.resolved] as const] : []
        )
      ).values()
    ]
    const inventory = await ports.refreshInventory(resolvedWorktrees, provider.connectionId)
    const hostId = provider.connectionId
      ? toSshExecutionHostId(provider.connectionId)
      : LOCAL_EXECUTION_HOST_ID
    if (!inventory || !inventory.queriedHostIds.has(hostId)) {
      provider.entries.forEach(({ candidate }) => deferredDispatchIds.add(candidate.dispatchId))
      continue
    }
    for (const { candidate, workspace } of provider.entries) {
      if (!workspace) {
        const identity = inventory.terminalIdentityByPtyId.get(candidate.ptyId)
        if (
          (!inventory.allLivePtyIds.has(candidate.ptyId) &&
            (await isAbsentLegacyWorkerTerminalProvenExited(
              ports,
              candidate,
              provider.connectionId
            ))) ||
          (identity &&
            (identity.handle !== candidate.terminalHandle ||
              identity.incarnationId !== candidate.incarnationId))
        ) {
          pendingResolutions.push({ candidate, resolution: 'exited', hostId })
        } else {
          deferredDispatchIds.add(candidate.dispatchId)
        }
        continue
      }
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
  const persistedDispatchIds =
    pendingResolutions.length > 0 ? await ports.persist(pendingResolutions) : new Set<string>()
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
    adoptedDispatchIds,
    exitedDispatchIds,
    deferredDispatchIds: [...deferredDispatchIds]
  }
  ports.updateRetry(plan, deferredDispatchIds, options)
  // Why: releases may only finish after the owning provider's terminals are rediscovered.
  if (!options.retry || pendingResolutions.length > 0 || ports.hasRequestedReleases()) {
    controller.trackBackgroundWork(
      ports.reconcileRequestedReleases().catch((error) => {
        console.warn('[orchestration] worker terminal release reconciliation failed', { error })
      })
    )
  }
  return result
}

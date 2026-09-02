import type { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerRecoveryOptions,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution,
  LegacyWorkerRecoveryWorkspace
} from './runtime-legacy-worker-terminal-recovery-types'

export async function reconcileLegacyWorkerCandidate(args: {
  controller: RuntimeLegacyWorkerTerminalRecoveryController
  ports: LegacyWorkerRecoveryPorts
  options: LegacyWorkerRecoveryOptions
  candidate: LegacyWorkerRecoveryCandidate
  workspace: LegacyWorkerRecoveryWorkspace
  resolvedWorktrees: LegacyWorkerRecoveryWorkspace['resolved'][]
  inventory: LegacyWorkerRecoveryInventory
  deferredDispatchIds: Set<string>
  pendingResolutions: LegacyWorkerRecoveryResolution[]
}): Promise<void> {
  const { controller, ports, options, candidate, workspace, resolvedWorktrees } = args
  if (!args.inventory.livePtyIds.has(candidate.ptyId)) {
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  const controllerIdentity = args.inventory.terminalIdentityByPtyId.get(candidate.ptyId)
  if (!controllerIdentity) {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (
    controllerIdentity.handle !== candidate.terminalHandle ||
    controllerIdentity.incarnationId !== candidate.incarnationId
  ) {
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  let adoptionStatus: 'ready' | 'unverifiable' | 'exited'
  try {
    adoptionStatus = await ports.runMutation(candidate.worktreeId, async () => {
      const preAdoptionInventory = await ports.refreshInventory(
        resolvedWorktrees,
        workspace.scope.connectionId
      )
      if (!preAdoptionInventory) {
        return 'unverifiable'
      }
      if (!preAdoptionInventory.livePtyIds.has(candidate.ptyId)) {
        return 'exited'
      }
      const preAdoptionIdentity = preAdoptionInventory.terminalIdentityByPtyId.get(candidate.ptyId)
      if (!preAdoptionIdentity) {
        return 'unverifiable'
      }
      if (
        preAdoptionIdentity.handle !== candidate.terminalHandle ||
        preAdoptionIdentity.incarnationId !== candidate.incarnationId
      ) {
        return 'exited'
      }
      const exactSurfaceAlreadyPublished =
        ports.hasExactPersistedSurface(candidate) && ports.hasExactSurface(candidate)
      if (!exactSurfaceAlreadyPublished) {
        await ports.adopt(
          candidate,
          workspace.scope,
          preAdoptionInventory,
          ports.getActivation(candidate.worktreeId)
        )
      }
      return 'ready'
    })
  } catch (error) {
    console.warn('[orchestration] legacy worker terminal adoption deferred', {
      dispatchId: candidate.dispatchId,
      error
    })
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (adoptionStatus === 'unverifiable') {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (adoptionStatus === 'exited') {
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  const rendererEpoch = ports.getRendererEpoch()
  let rendererMaterialized =
    options.materializeRenderer !== true || controller.hasReceipt(candidate.paneKey, rendererEpoch)
  if (options.materializeRenderer && !rendererMaterialized) {
    for (let attempt = 0; attempt < 2 && !rendererMaterialized; attempt += 1) {
      try {
        const reveal = await ports.reveal(candidate)
        if (reveal === null) {
          break
        }
        rendererMaterialized = reveal
        if (!rendererMaterialized) {
          throw new Error('terminal_reveal_identity_mismatch')
        }
        controller.setReceipt(candidate.paneKey, ports.getRendererEpoch())
      } catch (error) {
        if (attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
          continue
        }
        console.warn('[orchestration] adopted legacy worker was not revealed', {
          dispatchId: candidate.dispatchId,
          error
        })
      }
    }
  }
  if (!rendererMaterialized) {
    controller.deleteReceipt(candidate.paneKey)
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (options.materializeRenderer === true && !ports.hasExactSurface(candidate)) {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  const finalInventory = await ports.refreshInventory(
    resolvedWorktrees,
    workspace.scope.connectionId
  )
  if (!finalInventory) {
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (!finalInventory.livePtyIds.has(candidate.ptyId)) {
    controller.deleteReceipt(candidate.paneKey)
    ports.onPtyExit(candidate)
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  const finalIdentity = finalInventory.terminalIdentityByPtyId.get(candidate.ptyId)
  if (!finalIdentity) {
    controller.deleteReceipt(candidate.paneKey)
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  if (
    finalIdentity.handle !== candidate.terminalHandle ||
    finalIdentity.incarnationId !== candidate.incarnationId
  ) {
    controller.deleteReceipt(candidate.paneKey)
    args.pendingResolutions.push({ candidate, resolution: 'exited' })
    return
  }
  args.pendingResolutions.push({ candidate, resolution: 'adopted' })
}

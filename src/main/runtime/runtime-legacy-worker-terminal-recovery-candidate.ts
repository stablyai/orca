import type { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerRecoveryOptions,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution,
  LegacyWorkerRecoveryWorkspace
} from './runtime-legacy-worker-terminal-recovery-types'

/**
 * A listing that does not name the PTY is not an observation of its exit, and an id now held by a
 * different terminal identity is a RECYCLED id, not a death. Both are this client's bookkeeping;
 * only the execution host that watched the process end may certify it, and only for the incarnation
 * this dispatch stored. Everything else defers to the next sweep
 * (docs/reference/ssh-execution-boundary.md).
 */
async function settleAbsentCandidate(
  ports: LegacyWorkerRecoveryPorts,
  candidate: LegacyWorkerRecoveryCandidate
): Promise<'exited' | 'unverifiable'> {
  return (await ports.proveTerminalExited(candidate)) ? 'exited' : 'unverifiable'
}

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
    if ((await settleAbsentCandidate(ports, candidate)) === 'exited') {
      args.pendingResolutions.push({ candidate, resolution: 'exited' })
    } else {
      args.deferredDispatchIds.add(candidate.dispatchId)
    }
    return
  }
  const controllerIdentity = args.inventory.terminalIdentityByPtyId.get(candidate.ptyId)
  if (
    !controllerIdentity ||
    controllerIdentity.handle !== candidate.terminalHandle ||
    controllerIdentity.incarnationId !== candidate.incarnationId
  ) {
    args.deferredDispatchIds.add(candidate.dispatchId)
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
        return await settleAbsentCandidate(ports, candidate)
      }
      const preAdoptionIdentity = preAdoptionInventory.terminalIdentityByPtyId.get(candidate.ptyId)
      if (!preAdoptionIdentity) {
        return 'unverifiable'
      }
      if (
        preAdoptionIdentity.handle !== candidate.terminalHandle ||
        preAdoptionIdentity.incarnationId !== candidate.incarnationId
      ) {
        // The pane's binding to this id is our own tab bookkeeping, and the id now routes to a
        // different shell, so retire the surface. The dispatch still defers: a recycled id is not
        // a death.
        ports.rollback(candidate)
        return 'unverifiable'
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
    if ((await settleAbsentCandidate(ports, candidate)) === 'exited') {
      ports.onPtyExit(candidate)
      args.pendingResolutions.push({ candidate, resolution: 'exited' })
    } else {
      args.deferredDispatchIds.add(candidate.dispatchId)
    }
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
    // Same as the pre-adoption mismatch: unbind the surface, but certify nothing about the process.
    ports.rollback(candidate)
    args.deferredDispatchIds.add(candidate.dispatchId)
    return
  }
  args.pendingResolutions.push({ candidate, resolution: 'adopted' })
}

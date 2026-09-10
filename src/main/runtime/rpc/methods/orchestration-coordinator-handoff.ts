import { createHash } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { MaestroCoordinatorHandoffParamsSchema } from '../../../../shared/maestro-coordinator-handoff'
import { buildMaestroTerminalLeaseTitle } from '../../../../shared/maestro-terminal-lease'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { recordMaestroProviderRollover } from '../../orchestration/db/maestro-terminal-lease/maestro-provider-rollover-store'
import {
  adoptCurrentCoordinatorLease,
  claimMaestroCoordinatorHandoff,
  reconcileMaestroTerminalLease
} from '../../orchestration/maestro-terminal-lease-reconciliation'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requireCoordinatorHandoffStarter } from '../orchestration-legacy-current-authority'
import { resolveCoordinatorLaunchProfile } from './orchestration-coordinator-launch-profile'

async function waitForCoordinatorClaim(args: {
  timeoutMs: number
  signal?: AbortSignal
  getPhase: () => string | undefined
}): Promise<boolean> {
  const deadline = Date.now() + args.timeoutMs
  while (Date.now() < deadline) {
    if (args.signal?.aborted) {
      throw new OrchestrationError('request_aborted', 'Coordinator handoff was cancelled.')
    }
    if (
      ['coordinator_claimed', 'authority_committed', 'predecessor_reconciled'].includes(
        args.getPhase() ?? ''
      )
    ) {
      return true
    }
    await wait(50, undefined, { signal: args.signal })
  }
  return false
}

export const ORCHESTRATION_COORDINATOR_HANDOFF_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.coordinatorHandoff',
    params: MaestroCoordinatorHandoffParamsSchema,
    handler: async (params, context) => {
      const { runtime } = context
      const db = runtime.getOrchestrationDb()
      const principal =
        context.authenticatedCallerFingerprint ??
        context.orchestrationMutation?.callerFingerprint ??
        context.clientId ??
        'local-runtime'
      if (params.operation === 'show') {
        const receipt = db.getCoordinatorHandoff(params.requestId)
        if (!receipt) {
          throw new OrchestrationError('handoff_not_found', 'Handoff was not found.')
        }
        return { handoff: receipt }
      }
      if (params.operation === 'claim') {
        return {
          handoff: claimMaestroCoordinatorHandoff({
            runtime,
            requestId: params.requestId,
            terminalHandle: params.from,
            view: params.view,
            callerAuthority: context.orchestrationCompatibilityCallerAuthority
          })
        }
      }

      const { run, callerPaneKey } = requireCoordinatorHandoffStarter(runtime, {
        ...params,
        evidence: context.orchestrationCompatibilityEvidence
      })
      const computedDigest = `sha256:${createHash('sha256').update(params.capsule).digest('hex')}`
      if (computedDigest !== params.capsuleDigest) {
        throw new OrchestrationError('request_mismatch', 'Coordinator capsule digest mismatched.')
      }
      const replay = db.getCoordinatorHandoff(params.requestId)
      const target = await runtime.showManagedTerminalWorkspace(params.worktree)
      const predecessorLease = replay?.predecessorLeaseId
        ? db.getMaestroTerminalLease(replay.predecessorLeaseId)
        : db.getCoordinatorLease(params.runId, run.consumer_generation)
      const {
        launch,
        effectiveProfile: effectiveLaunchProfile,
        drifted: launchProfileDrift
      } = resolveCoordinatorLaunchProfile({
        agent: params.agent,
        model: params.model,
        effort: params.effort,
        settings: runtime.getClientSettings(),
        predecessorProfile: predecessorLease?.launchProfile
      })
      if (!replay) {
        await adoptCurrentCoordinatorLease({
          runtime,
          runId: params.runId,
          generation: run.consumer_generation,
          terminalHandle: params.from,
          paneKey: callerPaneKey,
          agent: params.agent,
          spawnedBy: principal,
          callerAuthority: context.orchestrationCompatibilityCallerAuthority
        })
      }
      const successorGeneration = replay?.claimedGeneration ?? run.consumer_generation + 1
      const title = buildMaestroTerminalLeaseTitle({
        role: 'coordinator',
        runId: params.runId,
        coordinatorGeneration: successorGeneration,
        agent: params.agent
      })
      let receipt = db.reserveCoordinatorHandoff({
        requestId: params.requestId,
        runId: params.runId,
        executionHostId: target.hostId ?? 'local',
        workspaceKey: parseWorkspaceKey(target.id) ? target.id : worktreeWorkspaceKey(target.id),
        title,
        launchProfile: effectiveLaunchProfile,
        spawnedBy: principal,
        ownerPrincipal: `coordinator:${params.runId}:g${successorGeneration}`,
        capsuleDigest: params.capsuleDigest,
        inputIdempotencyKey: params.inputIdempotencyKey,
        expectedGraphRevision: params.expectedGraphRevision,
        retentionPolicy: params.retain ? 'retain' : 'auto_release'
      })
      if (['blocked', 'outcome_unknown', 'predecessor_reconciled'].includes(receipt.phase)) {
        return { handoff: receipt }
      }
      if ((params.rolloverReason || launchProfileDrift) && receipt.predecessorLeaseId) {
        const rolloverReason =
          params.rolloverReason && !launchProfileDrift
            ? params.rolloverReason
            : 'launch_profile_drift'
        recordMaestroProviderRollover(db, receipt.predecessorLeaseId, rolloverReason)
      }
      if (launchProfileDrift) {
        return {
          handoff: db.blockCoordinatorHandoff({
            requestId: params.requestId,
            phase: 'blocked',
            code: 'launch_profile_drift'
          })
        }
      }
      if (receipt.phase === 'reserved' || receipt.phase === 'spawned') {
        try {
          const terminal =
            receipt.phase === 'reserved'
              ? await runtime.dedupeTerminalCreate(
                  principal,
                  `id:${target.id}`,
                  `handoff:${params.requestId}`,
                  true,
                  (canonicalWorktreeSelector, preAllocatedHandle) =>
                    runtime.createTerminal(canonicalWorktreeSelector, {
                      startupAgent: params.agent,
                      ...(launch.preferences ? { launchPreferences: launch.preferences } : {}),
                      title,
                      surfaceOwner: false,
                      orchestrationManagedLaunch: true,
                      ...(preAllocatedHandle ? { preAllocatedHandle } : {})
                    })
                )
              : await runtime.showTerminal(receipt.successorTerminalHandle ?? '')
          const incarnation = runtime.getTerminalProcessIncarnation(terminal.handle)
          const paneKey = runtime.getTerminalPaneKey(terminal.handle)
          if (!incarnation || !terminal.tabId || !paneKey) {
            throw new Error('successor_terminal_identity_unavailable')
          }
          const managedContext = runtime.buildTerminalManagedCliContext(terminal.handle)
          db.attachMaestroTerminalLease({
            leaseId: receipt.successorLeaseId,
            terminalHandle: terminal.handle,
            tabId: terminal.tabId,
            paneKey,
            ptyIncarnation: incarnation,
            processRootId: terminal.ptyId ?? null,
            executionHostId: managedContext.executionHostId,
            workspaceKey: managedContext.workspaceKey
          })
          receipt = db.advanceCoordinatorHandoff({
            requestId: params.requestId,
            phase: 'spawned',
            terminalHandle: terminal.handle,
            tabId: terminal.tabId,
            ptyIncarnation: incarnation
          })
          const readiness = await runtime.waitForTerminal(terminal.handle, {
            condition: 'tui-idle',
            timeoutMs: Math.min(params.timeoutMs ?? 60_000, 60_000),
            signal: context.signal
          })
          if (!readiness.satisfied) {
            throw new Error(`successor_not_ready:${readiness.blockedReason ?? readiness.status}`)
          }
          db.transitionMaestroTerminalLease({
            leaseId: receipt.successorLeaseId,
            state: 'ready'
          })
          const commandId = `handoff:${params.requestId}:capsule`
          const inputAcceptance = db.acceptMaestroTerminalInput({
            commandId,
            idempotencyKey: params.inputIdempotencyKey,
            contentDigest: params.capsuleDigest,
            enqueueSequence: 1,
            sender: {
              principalId: principal,
              authority: 'coordinator',
              runId: params.runId,
              coordinatorGeneration: receipt.claimedGeneration
            },
            leaseId: receipt.successorLeaseId,
            executionHostId: managedContext.executionHostId,
            workspaceKey: managedContext.workspaceKey,
            terminalHandle: terminal.handle,
            tabId: terminal.tabId,
            ptyIncarnation: incarnation,
            expectedLifecycleState: 'ready',
            observedInputSurface: 'ready_prompt',
            expiresAt: new Date(Date.now() + (params.timeoutMs ?? 60_000)).toISOString(),
            expectedGraphRevision: params.expectedGraphRevision
          })
          if (inputAcceptance.replayed && inputAcceptance.receipt.state === 'accepted') {
            db.transitionMaestroTerminalInput({
              commandId,
              state: 'delivery_unknown',
              rejectionCode: 'delivery_interrupted_before_receipt'
            })
            throw new Error('capsule_delivery_unknown')
          }
          if (!inputAcceptance.replayed) {
            const send = await runtime.sendTerminalAgentPrompt(terminal.handle, params.capsule)
            db.transitionMaestroTerminalInput({
              commandId,
              state: send.accepted ? 'written_to_pty' : 'delivery_unknown',
              bytesWritten: send.bytesWritten,
              enterWritten: send.accepted
            })
            if (!send.accepted) {
              throw new Error('capsule_delivery_unknown')
            }
          } else if (
            inputAcceptance.receipt.state !== 'written_to_pty' &&
            inputAcceptance.receipt.state !== 'acknowledged'
          ) {
            throw new Error(`capsule_delivery_${inputAcceptance.receipt.state}`)
          }
        } catch (error) {
          return {
            handoff: db.blockCoordinatorHandoff({
              requestId: params.requestId,
              phase: 'outcome_unknown',
              code: error instanceof Error ? error.message : String(error)
            })
          }
        }
      }
      const claimed = await waitForCoordinatorClaim({
        timeoutMs: Math.min(params.timeoutMs ?? 60_000, 60_000),
        signal: context.signal,
        getPhase: () => db.getCoordinatorHandoff(params.requestId)?.phase
      })
      if (!claimed) {
        return {
          handoff: db.blockCoordinatorHandoff({
            requestId: params.requestId,
            phase: 'outcome_unknown',
            code: 'coordinator_claim_timeout'
          })
        }
      }
      receipt = db.getCoordinatorHandoff(params.requestId) ?? receipt
      if (receipt.phase === 'predecessor_reconciled') {
        return { handoff: receipt }
      }
      const successor = db.getMaestroTerminalLease(receipt.successorLeaseId)
      if (!successor?.paneKey) {
        throw new OrchestrationError('handoff_incomplete', 'Successor pane is unavailable.')
      }
      if (receipt.phase === 'coordinator_claimed') {
        receipt = db.commitCoordinatorHandoffAuthority({
          requestId: params.requestId,
          coordinatorPaneKey: successor.paneKey
        })
      }
      if (receipt.predecessorLeaseId) {
        await reconcileMaestroTerminalLease({
          runtime,
          leaseId: receipt.predecessorLeaseId,
          currentCoordinatorGeneration: receipt.claimedGeneration
        })
      }
      receipt = db.advanceCoordinatorHandoff({
        requestId: params.requestId,
        phase: 'predecessor_reconciled'
      })
      return { handoff: receipt }
    }
  })
]

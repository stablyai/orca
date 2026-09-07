import { createHash } from 'node:crypto'
import {
  isDurableMutation,
  isTerminalPromptMutation
} from '../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { RpcRequest } from './core'
import {
  attachMutationReceipt,
  EFFECT_FREE_WORKER_DONE_CHECKPOINT,
  getPendingWorkerStartRecovery,
  hashCanonical,
  isResumablePendingWorkerDone,
  markReplayedPromptIncarnationReplaced,
  readPromptBasePayloadHash,
  readPromptBindingPayloadHash,
  replayStableCallerParams,
  shouldObserveCompletedMutation
} from './orchestration-mutation-receipt'

export {
  readMutationReplayNudge,
  readWorkerDoneReplayNudge,
  stripMutationReplayNudge
} from './orchestration-mutation-receipt'

export type DurableMutationInvocation = {
  identity: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
  recordReceipt: (receipt: unknown) => void
  markWorkerDoneEffectFree: () => void
  markEffectPossible: () => void
  replayedReceipt?: unknown
}

type InFlightMutation = {
  method: string
  payloadHash: string
  promise: Promise<unknown>
}

export class OrchestrationMutationExecutor {
  private readonly inFlight = new Map<string, InFlightMutation>()

  constructor(private readonly runtime: OrcaRuntimeService) {}

  async run(
    request: RpcRequest,
    params: unknown,
    invoke: (mutation?: DurableMutationInvocation) => unknown,
    callerFingerprintOverride?: string
  ): Promise<unknown> {
    const requestId = request.orchestrationRequestId
    if (!requestId || !isDurableMutation(request.method, params)) {
      return await invoke()
    }
    const callerFingerprint =
      callerFingerprintOverride ?? this.getLocalAuthenticatedCallerFingerprint()
    const stableParams = replayStableCallerParams(this.runtime, params)
    const basePayloadHash = hashCanonical({ method: request.method, params: stableParams })
    const key = `${callerFingerprint}:${requestId}`
    const db = this.runtime.getOrchestrationDb()
    const isPromptMutation = isTerminalPromptMutation(request.method, params)
    const existingPromptReceipt = isPromptMutation
      ? db.getMutationReceipt(callerFingerprint, requestId)
      : undefined
    if (
      existingPromptReceipt &&
      (existingPromptReceipt.method !== request.method ||
        readPromptBasePayloadHash(existingPromptReceipt.payload_hash) !== basePayloadHash)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Mutation request ${requestId} was already used with different input.`
      )
    }
    const recordedPromptBindingHash = existingPromptReceipt
      ? readPromptBindingPayloadHash(existingPromptReceipt.payload_hash)
      : null
    // The recorded observation is only true while the prompt's terminal incarnation survives, so
    // every replay re-checks the binding rather than only the --wait-submit ones.
    const promptBindingChanged =
      recordedPromptBindingHash !== null &&
      recordedPromptBindingHash !==
        this.readTerminalPromptBindingHash((params as { terminal: string }).terminal)
    const payloadHash = existingPromptReceipt
      ? existingPromptReceipt.payload_hash
      : isPromptMutation
        ? `${basePayloadHash}:${hashCanonical(
            this.runtime.getTerminalPromptRequestBinding((params as { terminal: string }).terminal)
          )}`
        : basePayloadHash
    const identity = { callerFingerprint, requestId, method: request.method, payloadHash }
    const atomicWorkerAcceptance =
      request.method === 'orchestration.workerStart' ||
      request.method === 'orchestration.federationAttachStart'
    // Worker starts perform asynchronous topology validation before their durable
    // acceptance claim. Join an identical in-process attempt before that boundary.
    if (atomicWorkerAcceptance) {
      const active = this.inFlight.get(key)
      if (active) {
        if (active.method !== request.method || active.payloadHash !== payloadHash) {
          throw new OrchestrationError(
            'request_mismatch',
            `Mutation request ${requestId} was already used with different input.`
          )
        }
        return attachMutationReceipt(await active.promise, requestId, true)
      }
    }
    const begun = existingPromptReceipt
      ? { disposition: existingPromptReceipt.state, row: existingPromptReceipt }
      : atomicWorkerAcceptance
        ? (() => {
            const row = db.getMutationReceipt(callerFingerprint, requestId)
            if (!row) {
              return { disposition: 'started' as const }
            }
            if (row.method !== request.method || row.payload_hash !== payloadHash) {
              throw new OrchestrationError(
                'request_mismatch',
                `Mutation request ${requestId} was already used with different input.`
              )
            }
            return { disposition: row.state, row }
          })()
        : db.beginMutationReceipt(identity)
    const resumedPendingWorkerDone =
      begun.disposition === 'pending' &&
      isResumablePendingWorkerDone(request.method, params, begun.row.receipt)
    const resumedPendingMutation =
      begun.disposition === 'pending' &&
      (request.method === 'orchestration.workerRelease' || resumedPendingWorkerDone)

    if (begun.disposition === 'completed') {
      const active = this.inFlight.get(key)
      if (active) {
        return attachMutationReceipt(await active.promise, requestId, true)
      }
      const receipt = JSON.parse(begun.row.receipt ?? 'null')
      if (promptBindingChanged) {
        return attachMutationReceipt(
          markReplayedPromptIncarnationReplaced(receipt),
          requestId,
          true
        )
      }
      if (!shouldObserveCompletedMutation(request.method, params, receipt)) {
        return attachMutationReceipt(receipt, requestId, true)
      }
      const replayObservation = Promise.resolve().then(() =>
        invoke({
          identity,
          recordReceipt: (result) => {
            db.completeMutationReceipt({
              ...identity,
              receipt: JSON.stringify(attachMutationReceipt(result, requestId, true))
            })
          },
          markWorkerDoneEffectFree: () => undefined,
          markEffectPossible: () => undefined,
          replayedReceipt: receipt
        })
      )
      this.inFlight.set(key, { method: request.method, payloadHash, promise: replayObservation })
      try {
        const observed = await replayObservation
        const replayed = attachMutationReceipt(observed, requestId, true)
        db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(replayed) })
        return replayed
      } catch {
        // The original mutation is already durable; an observation-only replay
        // must not turn a completed request into a retry or resend opportunity.
        return attachMutationReceipt(receipt, requestId, true)
      } finally {
        this.inFlight.delete(key)
      }
    }
    if (begun.disposition === 'pending') {
      const active = this.inFlight.get(key)
      if (active) {
        return attachMutationReceipt(await active.promise, requestId, true)
      }
      if (isTerminalPromptMutation(request.method, params)) {
        throw new OrchestrationError(
          'operation_unknown',
          `Terminal prompt ${requestId} may have reached its exact terminal incarnation before restart. It will not be sent again.`,
          { requestId }
        )
      }
      if (request.method !== 'orchestration.workerRelease' && !resumedPendingWorkerDone) {
        const recovery = getPendingWorkerStartRecovery(request.method, begun.row.receipt)
        throw new OrchestrationError(
          'operation_unknown',
          recovery
            ? `Worker start ${requestId} was accepted as Dispatch ${recovery.dispatchId} before restart. Inspect that Dispatch; do not start another worker.`
            : `Mutation ${requestId} may have been accepted before restart. Retry inspection or recovery with the same request ID.`,
          recovery
            ? {
                requestId,
                dispatchId: recovery.dispatchId,
                recoveryCommand: `orca orchestration worker-show --dispatch ${recovery.dispatchId} --json`
              }
            : { requestId }
        )
      }
    }

    const recordReceipt = (result: unknown): void => {
      db.completeMutationReceipt({
        ...identity,
        receipt: JSON.stringify(attachMutationReceipt(result, requestId, resumedPendingMutation))
      })
      // Keep completed receipts when post-commit notification fails; retries replay the durable effect.
      effectPossible = true
    }
    let effectPossible = false
    const active = Promise.resolve().then(() =>
      invoke({
        identity,
        recordReceipt,
        markWorkerDoneEffectFree: () => {
          db.checkpointPendingMutationReceipt({
            ...identity,
            receipt: EFFECT_FREE_WORKER_DONE_CHECKPOINT
          })
        },
        markEffectPossible: () => {
          effectPossible = true
        }
      })
    )
    this.inFlight.set(key, { method: request.method, payloadHash, promise: active })
    try {
      const result = await active
      const receipted = attachMutationReceipt(result, requestId, resumedPendingMutation)
      db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(receipted) })
      return receipted
    } catch (error) {
      if (
        (!isPromptMutation || !effectPossible) &&
        !(error instanceof OrchestrationError && error.code === 'operation_unknown')
      ) {
        db.discardPendingMutationReceipt(callerFingerprint, requestId)
      }
      throw error
    } finally {
      this.inFlight.delete(key)
    }
  }

  // A replayed prompt may name a terminal that is gone; an unreadable binding is a changed one.
  private readTerminalPromptBindingHash(handle: string): string | null {
    try {
      return hashCanonical(this.runtime.getTerminalPromptRequestBinding(handle))
    } catch {
      return null
    }
  }

  getLocalAuthenticatedCallerFingerprint(): string {
    return this.runtime.getOrchestrationDb().getOrCreateLocalMutationCallerFingerprint()
  }
}

const executorsByRuntime = new WeakMap<OrcaRuntimeService, OrchestrationMutationExecutor>()

export function getOrchestrationMutationExecutor(
  runtime: OrcaRuntimeService
): OrchestrationMutationExecutor {
  const existing = executorsByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const executor = new OrchestrationMutationExecutor(runtime)
  executorsByRuntime.set(runtime, executor)
  return executor
}

export function fingerprintAuthenticatedPairingCredential(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

import { createHash } from 'node:crypto'
import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { RpcRequest } from './core'

export type DurableMutationInvocation = {
  identity: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
  recordReceipt: (receipt: unknown) => void
}

export class OrchestrationMutationExecutor {
  private readonly inFlight = new Map<string, Promise<unknown>>()

  constructor(private readonly runtime: OrcaRuntimeService) {}

  async run(
    request: RpcRequest,
    params: unknown,
    invoke: (mutation?: DurableMutationInvocation) => unknown,
    callerFingerprintOverride?: string
  ): Promise<unknown> {
    const requestId = request.orchestrationRequestId
    if (!requestId || !isOrchestrationMutation(request.method, params)) {
      return await invoke()
    }
    const callerFingerprint =
      callerFingerprintOverride ?? this.getLocalAuthenticatedCallerFingerprint()
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify(
          canonicalize({
            method: request.method,
            params: replayStableCallerParams(this.runtime, params)
          })
        )
      )
      .digest('hex')
    const key = `${callerFingerprint}:${requestId}`
    const db = this.runtime.getOrchestrationDb()
    const identity = { callerFingerprint, requestId, method: request.method, payloadHash }
    const atomicWorkerAcceptance =
      request.method === 'orchestration.workerStart' ||
      request.method === 'orchestration.federationAttachStart'
    const begun = atomicWorkerAcceptance
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
    const resumedPendingMutation =
      begun.disposition === 'pending' && request.method === 'orchestration.workerRelease'

    if (begun.disposition === 'completed') {
      const active = this.inFlight.get(key)
      if (active) {
        return attachMutationReceipt(await active, requestId, true)
      }
      return attachMutationReceipt(JSON.parse(begun.row.receipt ?? 'null'), requestId, true)
    }
    if (begun.disposition === 'pending') {
      const active = this.inFlight.get(key)
      if (active) {
        return attachMutationReceipt(await active, requestId, true)
      }
      if (request.method !== 'orchestration.workerRelease') {
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
    }
    const active = Promise.resolve().then(() => invoke({ identity, recordReceipt }))
    this.inFlight.set(key, active)
    try {
      const result = await active
      const receipted = attachMutationReceipt(result, requestId, resumedPendingMutation)
      db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(receipted) })
      return receipted
    } catch (error) {
      if (!(error instanceof OrchestrationError && error.code === 'operation_unknown')) {
        db.discardPendingMutationReceipt(callerFingerprint, requestId)
      }
      throw error
    } finally {
      this.inFlight.delete(key)
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

function replayStableCallerParams(runtime: OrcaRuntimeService, params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return params
  }
  const source = params as Record<string, unknown>
  const result = { ...source }
  for (const property of ['from', 'callerTerminalHandle'] as const) {
    const handle = source[property]
    if (typeof handle !== 'string') {
      continue
    }
    const paneKey =
      property === 'from' && typeof source.senderPaneKey === 'string'
        ? source.senderPaneKey
        : runtime.getTerminalPaneKey(handle)
    if (paneKey) {
      const leafId = parsePaneKey(paneKey)?.leafId
      result[property] = leafId ? { paneLeafId: leafId } : { paneKey }
    }
  }
  return result
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      result[key] = canonicalize(source[key])
    }
  }
  return result
}

function attachMutationReceipt(result: unknown, requestId: string, replayed: boolean): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result, mutation: { requestId, replayed } }
  }
  return { ...(result as Record<string, unknown>), mutation: { requestId, replayed } }
}

function getPendingWorkerStartRecovery(
  method: string,
  receipt: string | null
): { dispatchId: string } | undefined {
  if (method !== 'orchestration.workerStart' || !receipt) {
    return undefined
  }
  try {
    const parsed = JSON.parse(receipt) as { accepted?: { dispatchId?: unknown } }
    return typeof parsed.accepted?.dispatchId === 'string'
      ? { dispatchId: parsed.accepted.dispatchId }
      : undefined
  } catch {
    return undefined
  }
}

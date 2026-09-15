import { createHash } from 'node:crypto'
import { isTerminalPromptMutation } from '../../../shared/orchestration-rpc-contract'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../orca-runtime'

export const EFFECT_FREE_WORKER_DONE_CHECKPOINT = JSON.stringify({
  pending: { effectFree: 'worker_done' }
})

const REPLAY_NUDGE_KEY = '__orcaReplayNudge'

export type MutationReplayNudge =
  | { kind: 'messages'; targets: { to: string; type: string }[] }
  | { kind: 'federation'; runId?: string }

export function replayStableCallerParams(runtime: OrcaRuntimeService, params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return params
  }
  const source = params as Record<string, unknown>
  const result = { ...source }
  delete result.waitSubmitMs
  for (const property of ['from', 'callerTerminalHandle', 'terminal'] as const) {
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

export function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

export function readPromptBasePayloadHash(payloadHash: string): string {
  return payloadHash.split(':', 1)[0] ?? payloadHash
}

/** Absent on receipts recorded before the binding was hashed into the payload. */
export function readPromptBindingPayloadHash(payloadHash: string): string | null {
  const separator = payloadHash.indexOf(':')
  return separator === -1 ? null : payloadHash.slice(separator + 1)
}

/** A stored `observation` only describes the incarnation the prompt was written to. */
export function markReplayedPromptIncarnationReplaced(receipt: unknown): unknown {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return receipt
  }
  const send = (receipt as { send?: { prompt?: { observation?: string } } }).send
  if (!send?.prompt) {
    return receipt
  }
  return {
    ...(receipt as Record<string, unknown>),
    send: { ...send, prompt: { ...send.prompt, observation: 'incarnation_replaced' } }
  }
}

export function shouldObserveCompletedMutation(
  method: string,
  params: unknown,
  receipt: unknown
): boolean {
  if (readMutationReplayNudge(receipt) || readWorkerDoneReplayNudge(method, params, receipt)) {
    return true
  }
  if (!isTerminalPromptMutation(method, params)) {
    return false
  }
  const waitSubmitMs = (params as { waitSubmitMs?: unknown }).waitSubmitMs
  if (typeof waitSubmitMs !== 'number' || waitSubmitMs <= 0) {
    return false
  }
  const stages = (receipt as { send?: { prompt?: { stages?: unknown } } } | null)?.send?.prompt
    ?.stages
  return Array.isArray(stages) && !stages.includes('turn_started')
}

export function attachMutationReplayNudge(
  receipt: unknown,
  replayNudge: MutationReplayNudge
): unknown {
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? { ...(receipt as Record<string, unknown>), [REPLAY_NUDGE_KEY]: replayNudge }
    : receipt
}

export function readMutationReplayNudge(receipt: unknown): MutationReplayNudge | undefined {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return undefined
  }
  const value = (receipt as Record<string, unknown>)[REPLAY_NUDGE_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as { kind?: unknown; targets?: unknown; runId?: unknown }
  if (candidate.kind === 'federation') {
    return candidate.runId === undefined || typeof candidate.runId === 'string'
      ? { kind: 'federation', ...(candidate.runId ? { runId: candidate.runId } : {}) }
      : undefined
  }
  if (candidate.kind !== 'messages' || !Array.isArray(candidate.targets)) {
    return undefined
  }
  const targets = candidate.targets.filter((target): target is { to: string; type: string } =>
    Boolean(
      target &&
      typeof target === 'object' &&
      typeof (target as { to?: unknown }).to === 'string' &&
      typeof (target as { type?: unknown }).type === 'string'
    )
  )
  return targets.length === candidate.targets.length && targets.length > 0
    ? { kind: 'messages', targets }
    : undefined
}

export function stripMutationReplayNudge(receipt: unknown): unknown {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return receipt
  }
  const result = { ...(receipt as Record<string, unknown>) }
  delete result[REPLAY_NUDGE_KEY]
  return result
}

export function isResumablePendingWorkerDone(
  method: string,
  params: unknown,
  receipt: string | null
): boolean {
  return isWorkerDoneSend(method, params) && receipt === EFFECT_FREE_WORKER_DONE_CHECKPOINT
}

export function readWorkerDoneReplayNudge(
  method: string,
  params: unknown,
  receipt: unknown
): { to: string; type: string } | undefined {
  if (!isWorkerDoneSend(method, params) || !receipt || typeof receipt !== 'object') {
    return undefined
  }
  const result = receipt as { lifecycle?: unknown; message?: unknown }
  if (!result.lifecycle || typeof result.lifecycle !== 'object') {
    return undefined
  }
  const action = (result.lifecycle as { action?: unknown }).action
  if (action !== 'completed' && action !== 'failed' && action !== 'rejected') {
    return undefined
  }
  if (!result.message || typeof result.message !== 'object') {
    return undefined
  }
  const row = result.message as { to_handle?: unknown; type?: unknown }
  return typeof row.to_handle === 'string' && typeof row.type === 'string'
    ? { to: row.to_handle, type: row.type }
    : undefined
}

export function attachMutationReceipt(
  result: unknown,
  requestId: string,
  replayed: boolean
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result, mutation: { requestId, replayed } }
  }
  return { ...(result as Record<string, unknown>), mutation: { requestId, replayed } }
}

export function getPendingWorkerStartRecovery(
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

function isWorkerDoneSend(method: string, params: unknown): boolean {
  return (
    method === 'orchestration.send' &&
    Boolean(params) &&
    typeof params === 'object' &&
    !Array.isArray(params) &&
    (params as { type?: unknown }).type === 'worker_done'
  )
}

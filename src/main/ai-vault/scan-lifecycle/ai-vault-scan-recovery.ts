import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'

export type ScanOutcome = { order: number; scanId?: string } & (
  | { ok: true; result: AiVaultListResult }
  | { ok: false; error: unknown }
)
type Interest = {
  forced: number
  inherited: number
  sources: Map<symbol, number>
  required: number
  observation: number
  receipts: Map<string, ScanOutcome>
  listeners: Set<() => void>
}
const interests = new WeakMap<AbortSignal, Interest>()
let order = 0
export const nextScanObservationOrder = (): number => ++order

export function scanForceOrder(force: boolean | undefined, parent?: AbortSignal): number {
  return scanRecoveryInterest(parent)?.required || (force ? nextScanObservationOrder() : 0)
}

export function createScanRecoveryInterest(signal: AbortSignal): Interest {
  const interest: Interest = {
    forced: 0,
    inherited: 0,
    sources: new Map(),
    required: 0,
    observation: 0,
    receipts: new Map(),
    listeners: new Set()
  }
  interests.set(signal, interest)
  return interest
}

export function scanRecoveryInterest(signal?: AbortSignal): Interest | undefined {
  return signal ? interests.get(signal) : undefined
}

export function notifyScanRecoveryInterest(interest: Interest): void {
  for (const listener of interest.listeners) {
    listener()
  }
}

/** Receipts belong to live parent chains, including a trailing owner after local completion. */
export function recordScanOutcome(
  parent: AbortSignal | undefined,
  key: string,
  outcome: ScanOutcome
): void {
  scanRecoveryInterest(parent)?.receipts.set(key, outcome)
}

export function inheritScanRecoveryInterest(
  parent: AbortSignal | undefined,
  child: AbortSignal
): () => void {
  const source = scanRecoveryInterest(parent)
  const target = scanRecoveryInterest(child)
  return source && target ? forwardScanRecoveryInterest(source, target) : () => undefined
}

/** Counts flow toward execution only; independent attachments detach independently. */
export function forwardScanRecoveryInterest(source: Interest, target: Interest): () => void {
  const token = Symbol()
  const updateTotal = () => {
    target.inherited = 0
    for (const value of target.sources.values()) {
      target.inherited += value
    }
    notifyScanRecoveryInterest(target)
  }
  const update = () => {
    target.sources.set(token, source.forced + source.inherited)
    updateTotal()
  }
  source.listeners.add(update)
  update()
  return () => {
    source.listeners.delete(update)
    target.sources.delete(token)
    updateTotal()
  }
}

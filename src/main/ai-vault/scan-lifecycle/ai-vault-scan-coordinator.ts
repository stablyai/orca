import { AiVaultScanRowObservers } from './ai-vault-scan-row-observers'
import { randomUUID } from 'node:crypto'
import {
  AI_VAULT_SCAN_CANCELLED_MESSAGE,
  type AiVaultListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
import {
  createScanRecoveryInterest,
  forwardScanRecoveryInterest,
  inheritScanRecoveryInterest,
  notifyScanRecoveryInterest,
  scanRecoveryInterest,
  scanForceOrder,
  nextScanObservationOrder,
  recordScanOutcome,
  type ScanOutcome
} from './ai-vault-scan-recovery'

type Run = {
  key: string
  force?: boolean
  requiredOrder?: number
  aggregate?: boolean
  signal?: AbortSignal
  observeRows?: (rows: AiVaultScanRows) => void
  onCreate?: (id: string) => void
  onError?: (error: unknown) => void
  onReject?: (error: unknown, id: string) => unknown
  start: (
    signal: AbortSignal,
    id: string,
    publish: (delta: AiVaultRowDelta) => void
  ) => Promise<AiVaultListResult>
}
type Entry = {
  id: string
  controller: AbortController
  promise: Promise<AiVaultListResult>
  waiters: number
  started: boolean
  settled: boolean
  requirements: Map<symbol, number>
  outcome?: ScanOutcome
  rows: AiVaultScanRowObservers
}

/** A force arriving during observation owns one trailing pass, without aborting healthy work. */
export class AiVaultScanCoordinator {
  private readonly entries = new Map<string, Entry>()

  run(args: Run): Promise<AiVaultListResult> {
    if (args.signal?.aborted) {
      return Promise.reject(scanCancellationError())
    }
    args = { ...args, requiredOrder: args.requiredOrder ?? scanForceOrder(args.force, args.signal) }
    const receipt = scanRecoveryInterest(args.signal)?.receipts.get(args.key)
    if (args.requiredOrder && receipt && receipt.order > args.requiredOrder) {
      return receipt.ok
        ? Promise.resolve(receipt.result)
        : Promise.reject(
            args.onReject ? args.onReject(receipt.error, receipt.scanId ?? '') : receipt.error
          )
    }
    let entry = this.entries.get(args.key)
    const leading = entry
    const trailing =
      !!entry &&
      !!args.requiredOrder &&
      entry.started &&
      (scanRecoveryInterest(entry.controller.signal)?.observation ?? 0) <= args.requiredOrder
    if (!entry || trailing) {
      entry = this.create(args, trailing ? leading : undefined)
      this.entries.set(args.key, entry)
    }
    return this.attach(args, entry)
  }

  private create(args: Run, leading?: Entry): Entry {
    const controller = new AbortController()
    const interest = createScanRecoveryInterest(controller.signal)
    const leadingInterest = leading ? scanRecoveryInterest(leading.controller.signal) : undefined
    const releaseLeading = leadingInterest
      ? forwardScanRecoveryInterest(interest, leadingInterest)
      : () => undefined
    if (leadingInterest) {
      interest.receipts = leadingInterest.receipts
    }
    const id = randomUUID()
    const entry: Entry = {
      id,
      controller,
      promise: Promise.resolve(undefined!),
      waiters: 0,
      started: false,
      settled: false,
      requirements: new Map(),
      rows: new AiVaultScanRowObservers(id, controller.signal)
    }
    const hold = leading ? new AbortController() : null
    const held =
      leading && hold
        ? this.attach(
            { ...args, force: false, requiredOrder: 0, signal: hold.signal },
            leading
          ).then(
            () => leading.outcome,
            () => leading.outcome
          )
        : null
    const releaseHold = () => hold?.abort()
    controller.signal.addEventListener('abort', releaseHold, { once: true })
    entry.promise = Promise.resolve().then(async () => {
      if (leading) {
        const outcome = await held
        releaseHold()
        const required = Math.max(0, ...entry.requirements.values())
        if (outcome && outcome.order > required) {
          interest.observation = outcome.order
          if (outcome.ok) {
            return outcome.result
          }
          throw outcome.error
        }
      }
      if (controller.signal.aborted) {
        throw scanCancellationError()
      }
      entry.started = true
      interest.required = Math.max(0, ...entry.requirements.values())
      interest.observation = args.aggregate ? 0 : nextScanObservationOrder()
      args.onCreate?.(id)
      try {
        return await args.start(controller.signal, id, entry.rows.publish)
      } finally {
        if (args.aggregate) {
          interest.observation = interest.receipts.size
            ? Math.min(...[...interest.receipts.values()].map((receipt) => receipt.order))
            : 0
        }
      }
    })
    const settle = () => {
      entry.settled = true
      entry.rows.dispose()
      releaseLeading()
      releaseHold()
      controller.signal.removeEventListener('abort', releaseHold)
      if (this.entries.get(args.key) === entry) {
        this.entries.delete(args.key)
      }
    }
    void entry.promise.then(
      (result) => {
        entry.outcome = { ok: true, result, order: interest.observation, scanId: id }
        settle()
      },
      (error) => {
        entry.outcome = { ok: false, error, order: interest.observation, scanId: id }
        args.onError?.(error)
        settle()
      }
    )
    return entry
  }

  private attach(args: Run, entry: Entry): Promise<AiVaultListResult> {
    entry.waiters++
    const interest = scanRecoveryInterest(entry.controller.signal)
    const forced = !!args.requiredOrder
    const releaseParent = inheritScanRecoveryInterest(args.signal, entry.controller.signal)
    const obligation = Symbol()
    if (forced) {
      entry.requirements.set(obligation, args.requiredOrder ?? 0)
    }
    if (forced && interest) {
      interest.forced++
      notifyScanRecoveryInterest(interest)
    }
    const releaseRows = entry.rows.attach(args.observeRows)
    return new Promise((resolve, reject) => {
      let attached = true
      const detach = () => {
        if (!attached) {
          return
        }
        attached = false
        args.signal?.removeEventListener('abort', abort)
        releaseRows()
        entry.waiters--
        entry.requirements.delete(obligation)
        releaseParent()
        if (forced && interest) {
          interest.forced--
          notifyScanRecoveryInterest(interest)
        }
        if (!entry.waiters && !entry.settled) {
          if (this.entries.get(args.key) === entry) {
            this.entries.delete(args.key)
          }
          entry.controller.abort()
        }
      }
      const abort = () => {
        detach()
        reject(scanCancellationError())
      }
      args.signal?.addEventListener('abort', abort, { once: true })
      if (args.signal?.aborted) {
        abort()
        return
      }
      void entry.promise.then(
        (result) => {
          if (attached) {
            if (entry.outcome) {
              recordScanOutcome(args.signal, args.key, entry.outcome)
            }
            detach()
            resolve(result)
          }
        },
        (error) => {
          if (attached) {
            if (entry.outcome && !entry.controller.signal.aborted) {
              recordScanOutcome(args.signal, args.key, entry.outcome)
            }
            detach()
            reject(args.onReject ? args.onReject(error, entry.id) : error)
          }
        }
      )
    })
  }
}

function scanCancellationError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}

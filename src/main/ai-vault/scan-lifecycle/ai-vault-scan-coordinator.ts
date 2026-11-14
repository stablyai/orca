import { AiVaultScanRowObservers } from './ai-vault-scan-row-observers'
import { randomUUID } from 'node:crypto'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { createAiVaultScanCancelledError as scanCancellationError } from './ai-vault-scan-cancellation'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
import {
  acceptScanOutcome,
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
  onAccept?: (outcome: ScanOutcome, requiredOrder: number) => void
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

type ExecutionOwner = { active: Entry; queued?: Entry }

/** A force arriving during observation owns one trailing pass, without aborting healthy work. */
export class AiVaultScanCoordinator {
  private readonly entries = new Map<string, ExecutionOwner>()

  run(args: Run): Promise<AiVaultListResult> {
    if (args.signal?.aborted) {
      return Promise.reject(scanCancellationError())
    }
    args = { ...args, requiredOrder: args.requiredOrder ?? scanForceOrder(args.force, args.signal) }
    const receipt = scanRecoveryInterest(args.signal)?.receipts.get(args.key)
    if (args.requiredOrder && receipt && receipt.order > args.requiredOrder) {
      acceptScanOutcome(receipt, args.requiredOrder)
      return receipt.ok
        ? Promise.resolve(receipt.result)
        : Promise.reject(
            args.onReject ? args.onReject(receipt.error, receipt.scanId ?? '') : receipt.error
          )
    }
    let owner = this.entries.get(args.key)
    const active = owner?.active
    const trailing =
      !!active &&
      (active.controller.signal.aborted ||
        (!!args.requiredOrder &&
          active.started &&
          (scanRecoveryInterest(active.controller.signal)?.observation ?? 0) <= args.requiredOrder))
    let entry = trailing ? owner?.queued : active
    if (!entry) {
      const completion = Promise.withResolvers<AiVaultListResult>()
      entry = this.create(completion.promise)
      const leading = trailing ? owner?.active : undefined
      if (owner) {
        owner.queued = entry
      } else {
        owner = { active: entry }
        this.entries.set(args.key, owner)
      }
      const attached = this.attach(args, entry, owner)
      this.launch(args, entry, owner, completion, leading)
      return attached
    }
    return this.attach(args, entry, owner!)
  }

  private create(promise: Promise<AiVaultListResult>): Entry {
    const controller = new AbortController()
    createScanRecoveryInterest(controller.signal)
    const id = randomUUID()
    return {
      id,
      controller,
      promise,
      waiters: 0,
      started: false,
      settled: false,
      requirements: new Map(),
      rows: new AiVaultScanRowObservers(id, controller.signal)
    }
  }

  private launch(
    args: Run,
    entry: Entry,
    owner: ExecutionOwner,
    completion: ReturnType<typeof Promise.withResolvers<AiVaultListResult>>,
    leading?: Entry
  ): void {
    const { controller, id } = entry
    const interest = scanRecoveryInterest(controller.signal)!
    const leadingInterest = leading ? scanRecoveryInterest(leading.controller.signal) : undefined
    const releaseLeading = leadingInterest
      ? forwardScanRecoveryInterest(interest, leadingInterest)
      : () => undefined
    if (leadingInterest) {
      interest.receipts = leadingInterest.receipts
    }
    const hold = leading ? new AbortController() : null
    const held =
      leading && hold
        ? this.attach(
            { ...args, force: false, requiredOrder: 0, signal: hold.signal },
            leading,
            owner
          ).then(
            () => leading.outcome,
            () => leading.outcome
          )
        : null
    const releaseHold = () => hold?.abort()
    controller.signal.addEventListener('abort', releaseHold, { once: true })
    if (controller.signal.aborted) {
      releaseHold()
    }
    let acceptedLeading: ScanOutcome | undefined
    const running = Promise.resolve().then(async () => {
      if (leading) {
        const outcome = await held
        releaseHold()
        if (controller.signal.aborted) {
          throw scanCancellationError()
        }
        const required = Math.max(0, ...entry.requirements.values())
        if (!leading.controller.signal.aborted && outcome && outcome.order > required) {
          interest.observation = outcome.order
          acceptedLeading = outcome
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
      if (owner.active === entry) {
        if (owner.queued) {
          owner.active = owner.queued
          owner.queued = undefined
        } else if (this.entries.get(args.key) === owner) {
          this.entries.delete(args.key)
        }
      } else if (owner.queued === entry) {
        owner.queued = undefined
      }
      entry.rows.dispose()
      releaseLeading()
      releaseHold()
      controller.signal.removeEventListener('abort', releaseHold)
    }
    const accept = (requiredOrder: number) => {
      if (!entry.outcome?.ok || entry.outcome.order <= requiredOrder) {
        return
      }
      if (acceptedLeading) {
        acceptedLeading.accept?.(requiredOrder)
      } else {
        args.onAccept?.(entry.outcome, requiredOrder)
      }
      for (const outcome of interest.receipts.values()) {
        acceptScanOutcome(outcome, requiredOrder)
      }
    }
    void running.then(
      (result) => {
        entry.outcome = { ok: true, result, order: interest.observation, scanId: id, accept }
        settle()
        completion.resolve(result)
      },
      (error) => {
        entry.outcome = { ok: false, error, order: interest.observation, scanId: id }
        settle()
        args.onError?.(error)
        completion.reject(error)
      }
    )
  }

  private attach(args: Run, entry: Entry, owner: ExecutionOwner): Promise<AiVaultListResult> {
    return new Promise((resolve, reject) => {
      let attached = true
      let releaseRows: () => void = () => undefined
      let releaseParent: () => void = () => undefined
      const interest = scanRecoveryInterest(entry.controller.signal)
      const forced = args.force === true && scanRecoveryInterest(args.signal) === undefined
      const obligation = Symbol()
      entry.waiters++
      if (args.requiredOrder) {
        entry.requirements.set(obligation, args.requiredOrder)
      }
      if (forced && interest) {
        interest.forced++
      }
      const detach = () => {
        if (!attached) {
          return
        }
        attached = false
        args.signal?.removeEventListener('abort', abort)
        entry.waiters--
        entry.requirements.delete(obligation)
        if (forced && interest) {
          interest.forced--
        }
        if (!entry.waiters && !entry.settled) {
          if (owner.queued === entry) {
            owner.queued = undefined
          }
          entry.controller.abort()
        }
        releaseRows()
        releaseParent()
        if (forced && interest) {
          notifyScanRecoveryInterest(interest)
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
      const parent = inheritScanRecoveryInterest(args.signal, entry.controller.signal)
      if (attached) {
        releaseParent = parent
      } else {
        parent()
      }
      const rows = entry.rows.attach(args.observeRows)
      if (attached) {
        releaseRows = rows
      } else {
        rows()
      }
      if (forced && interest) {
        notifyScanRecoveryInterest(interest)
      }

      void entry.promise.then(
        (result) => {
          if (attached) {
            if (entry.outcome) {
              entry.outcome.accept?.(args.requiredOrder ?? 0)
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

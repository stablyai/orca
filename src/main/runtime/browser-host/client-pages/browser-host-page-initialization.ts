import { createInitializationCleanup } from './browser-host-page-initialization-closed-cleanup'
import { claimLegacyPageRecovery } from './browser-host-page-legacy-recovery'
import { BrowserHostPageInitializationControls } from './browser-host-page-initialization-controls'
import {
  initializationQueue,
  scheduleInitializationQueue,
  waitForInitializationPartition
} from './browser-host-page-initialization-queue'
import { settleInitialization } from './browser-host-page-initialization-settlement'
import {
  admitInitialization,
  retireUnpublishedInitialization,
  type InitializationAdmissionOwner
} from './browser-host-page-initialization-admission'
import { retireInitializationAuthority } from './browser-host-page-initialization-lifetime'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type {
  BrowserHostLeaseIdentity,
  BrowserHostLeaseState
} from '../leases/browser-host-lease-records'
import {
  canContinueInitialization,
  type InitializationAdmission,
  type Initialization,
  type InitializationRecord,
  type InitializationQueue,
  type InitializationDisposition,
  type InitializationOutcome,
  type BrowserHostPageInitializationInput
} from './browser-host-page-initialization-records'
import { closeInitializationGuest } from './browser-host-page-initialization-commands'
import { observeInitializationAttach } from './browser-host-page-initialization-attachment'
import {
  runInitializationTransaction,
  type InitializationTransactionAuthority
} from './browser-host-page-initialization-transaction'
export type { BrowserHostPageInitializationInput } from './browser-host-page-initialization-records'

export class BrowserHostPageInitializations extends BrowserHostPageInitializationControls {
  private readonly queues = new Map<symbol, InitializationQueue>()

  constructor(
    private readonly authority: Omit<InitializationTransactionAuthority, 'current'>,
    requireState: (state: BrowserHostLeaseState) => void,
    private readonly retireLease: (state: BrowserHostLeaseState) => void,
    changed: (workspaceId: string) => void = () => {}
  ) {
    super(requireState, changed)
  }

  canContinue(
    id: string,
    expected: RuntimeBrowserClientPlacement,
    lease: BrowserHostLeaseIdentity
  ): boolean {
    return canContinueInitialization(
      this.records.get(id),
      expected,
      lease,
      this.authority.placements.getPlacement(id)
    )
  }

  claimLegacyRecovery(
    state: BrowserHostLeaseState,
    input: Parameters<typeof claimLegacyPageRecovery>[2]
  ) {
    return claimLegacyPageRecovery(
      {
        records: this.records,
        placements: this.authority.placements,
        requireState: this.requireState,
        removeRecord: (record) => this.removeRecord(record),
        cleanup: (record, current, release, isCurrent) =>
          this.startClosedCleanup(record, current, release, isCurrent)
      },
      state,
      input
    )
  }

  sealAttach(state: BrowserHostLeaseState, blocked: boolean, connectionId?: string): void {
    if (connectionId && state.lease.connectionId !== connectionId) {
      return
    }
    // Unclaimed requests end at this attach; claimed requests already transferred before cancellation.
    for (const record of this.completion.pendingRecords(state)) {
      const operation = record.operation
      if (
        operation?.admission.state === state &&
        operation.admission.connectionToken !== state.connectionToken
      ) {
        this.cancelOperation(operation)
      }
    }
    this.preparation.seal(state)
    this.completion.seal(state, blocked)
  }

  observeAttach(
    state: BrowserHostLeaseState,
    inventory: readonly BrowserClientHostedPageInventory[] | undefined,
    complete: () => void = () => {}
  ): void {
    this.preparation.observe(state)
    this.completion.begin(state, this.records.values(), complete)
    this.attachments.set(state.lease.browserHostClientId, state)
    observeInitializationAttach(
      this.records,
      state,
      inventory,
      (operation) => this.cancelOperation(operation),
      (record) => this.removeRecord(record)
    )
  }

  admit(
    state: BrowserHostLeaseState,
    input: BrowserHostPageInitializationInput
  ): InitializationDisposition {
    return admitInitialization(this.admissionOwner(), state, input)
  }

  retireUnpublished(
    state: BrowserHostLeaseState,
    input: BrowserHostPageInitializationInput,
    cleanup?: { executionHostKey: string; releaseGrant(): void }
  ): void {
    retireUnpublishedInitialization(this.admissionOwner(), state, input, cleanup)
  }

  retireAuthority(state: BrowserHostLeaseState): void {
    const changed = new Set(
      [...this.records.values()]
        .filter((record) => record.scope === state && this.presentation(record))
        .map((record) => record.workspaceId)
    )
    const affected = new Set([state.lease.pairedDeviceId])
    this.completion.retire(state)
    retireInitializationAuthority(
      this.records,
      this.queues,
      this.attachments,
      (admission) => this.releaseAdmission(admission),
      (record, admission) => this.enqueue(record, admission),
      (id) => this.authority.placements.claimClientPageCleanup(id),
      (record) => this.removeRecord(record, affected),
      state
    )
    this.preparation.retire(state)
    this.completion.publishDevices(affected)
    for (const workspace of changed) {
      this.changed(workspace)
    }
  }

  private admissionOwner(): InitializationAdmissionOwner {
    return {
      records: this.records,
      removeRecord: (record) => this.removeRecord(record),
      placements: this.authority.placements,
      join: (state, record) => this.completion.join(state, record),
      requireState: this.requireState,
      observer: (state, input) => this.observer(state, input),
      cancelOperation: (operation) => this.cancelOperation(operation),
      releaseAdmission: (admission) => this.releaseAdmission(admission),
      enqueue: (record, admission) => this.enqueue(record, admission),
      resume: (state) => this.resume(state),
      startClosedCleanup: (record, state, releaseGrant) =>
        this.startClosedCleanup(record, state, releaseGrant)
    }
  }

  private enqueue(record: InitializationRecord, admission: InitializationAdmission): void {
    const operation: Initialization = {
      record,
      admission,
      controller: new AbortController(),
      running: false,
      executing: false,
      detached: false,
      phase: 'cleanup'
    }
    record.scope = admission.state
    record.operation = operation
    this.completion.join(admission.state, record)
    this.preparation.register(admission.state, record)
    const queue = initializationQueue(this.queues, admission.state.token)
    queue.pending.push(operation)
    this.schedule(admission.state.token, queue)
  }

  private schedule(token: symbol, queue: InitializationQueue): void {
    scheduleInitializationQueue(
      this.queues,
      token,
      queue,
      (operation) =>
        runInitializationTransaction(operation, {
          ...this.authority,
          current: (op) => this.current(op)
        }),
      (operation, outcome) => this.settle(operation, outcome)
    )
  }

  private current(operation: Initialization): void {
    const { admission, record } = operation
    this.requireState(admission.state)
    if (
      operation.detached ||
      record.operation !== operation ||
      record.closed ||
      operation.controller.signal.aborted ||
      admission.connectionToken !== admission.state.connectionToken ||
      !admission.input.isCurrent()
    ) {
      throw new Error('browser_client_page_initialization_stale')
    }
  }

  protected override cancelOperation(operation: Initialization): void {
    if (operation.detached) {
      return
    }
    operation.removePreparation?.()
    operation.removePreparation = undefined
    operation.controller.abort()
    operation.admission.input.completed?.()
    if (operation.admission.reservation) {
      this.authority.placements.cancelClientPageReservation(operation.admission.reservation)
    }
    if (!operation.running && !operation.record.target) {
      const queue = this.queues.get(operation.admission.state.token)
      const index = queue?.pending.indexOf(operation) ?? -1
      if (index >= 0) {
        queue?.pending.splice(index, 1)
      }
      this.clean(operation)
    }
  }

  protected override clean(operation: Initialization): void {
    if (operation.executing || operation.detached) {
      return
    }
    operation.executing = true
    void Promise.resolve()
      .then(() => closeInitializationGuest(operation))
      .then(
        () => this.settle(operation, operation.record.closed ? 'disposed' : 'retained-clean'),
        () => this.settle(operation, 'cleanup-unknown')
      )
  }

  protected override startClosedCleanup(
    record: InitializationRecord,
    state: BrowserHostLeaseState,
    releaseGrant?: () => void,
    preserveContinuation?: () => boolean
  ): void {
    const operation = createInitializationCleanup(
      record,
      (input) => this.observer(state, input),
      releaseGrant,
      preserveContinuation
    )
    record.scope = state
    record.operation = operation
    this.completion.join(state, record)
    this.preparation.register(state, record)
    // A rebound native close is charged to the current dispatcher; no replacement is created.
    const queue = initializationQueue(this.queues, state.token)
    queue.pending.push(operation)
    this.schedule(state.token, queue)
  }

  private settle(operation: Initialization, outcome: InitializationOutcome): void {
    if (operation.detached || operation.record.operation !== operation) {
      return
    }
    const { record, admission } = operation
    const before = this.presentation(record)
    if (outcome === 'prepared') {
      waitForInitializationPartition(operation, this.preparation, this.queues, (token, queue) =>
        this.schedule(token, queue)
      )
      return
    }
    operation.cleanupFailed = outcome === 'cleanup-unknown'
    if (!record.target) {
      this.preparation.joined(admission.state, record)
    }
    settleInitialization(operation, outcome, {
      authority: this.authority,
      completed: (record, outcome) => this.completion.settle(record, outcome),
      removeRecord: (record) => this.removeRecord(record),
      queues: this.queues,
      retireLease: this.retireLease,
      clean: (op) => this.clean(op),
      releaseAdmission: (admission) => this.releaseAdmission(admission),
      enqueue: (record, admission) => this.enqueue(record, admission),
      schedule: (token, queue) => this.schedule(token, queue)
    })
    if (before !== this.presentation(this.records.get(record.browserPageId))) {
      this.changed(record.workspaceId)
    }
  }

  protected override releaseAdmission(admission: InitializationAdmission): void {
    admission.removeAbort()
    admission.input.completed?.()
    if (admission.reservation) {
      this.authority.placements.cancelClientPageReservation(admission.reservation)
    }
  }
}

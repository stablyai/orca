import { AsyncLocalStorage } from 'node:async_hooks'

type CaptureState = {
  pending: Set<Promise<unknown>>
  operations: Set<symbol>
  waiters: Set<() => void>
  admissionWaiters: Set<() => void>
  reservation: BrowserCaptureReservation | null
}

type CaptureTarget = object

type CaptureOperation = {
  target: CaptureTarget
  identity: symbol
}

export type BrowserCaptureReservation = {
  readonly id: symbol
  release: () => void
}

export class BrowserCaptureIdle {
  private readonly states = new WeakMap<CaptureTarget, CaptureState>()
  private readonly activeOperation = new AsyncLocalStorage<CaptureOperation>()

  async runCapture<T>(
    webContents: CaptureTarget,
    operation: () => Promise<T>,
    reservation?: BrowserCaptureReservation
  ): Promise<T> {
    this.assertCaptureAllowed(webContents, reservation)
    const state = this.getState(webContents)
    const identity = Symbol('browser-capture-operation')
    state.operations.add(identity)
    try {
      return await this.activeOperation.run({ target: webContents, identity }, operation)
    } finally {
      state.operations.delete(identity)
      this.notifyIfIdle(webContents, state)
    }
  }

  runWhenCaptureAllowed<T>(webContents: CaptureTarget, operation: () => Promise<T>): Promise<T> {
    const state = this.getState(webContents)
    if (!state.reservation) {
      return this.runCapture(webContents, operation)
    }
    // A release wakes queued callers; each rechecks admission before entering its operation.
    return new Promise<void>((resolve) => state.admissionWaiters.add(resolve)).then(() =>
      this.runWhenCaptureAllowed(webContents, operation)
    )
  }

  trackPrimary<T>(webContents: CaptureTarget, operation: Promise<T>): Promise<T> {
    return this.track(webContents, operation)
  }

  trackNative<T>(webContents: CaptureTarget, operation: Promise<T>): Promise<T> {
    return this.track(webContents, operation)
  }

  isIdle(webContents: CaptureTarget): boolean {
    const state = this.states.get(webContents)
    return !state || (!state.pending.size && !state.operations.size)
  }

  waitForIdle(webContents: CaptureTarget): Promise<void> {
    const state = this.states.get(webContents)
    if (!state || this.isIdle(webContents)) {
      return Promise.resolve()
    }
    return new Promise((resolve) => state.waiters.add(resolve))
  }

  reserve(webContents: CaptureTarget): Promise<BrowserCaptureReservation> {
    const state = this.getState(webContents)
    if (state.reservation) {
      return Promise.reject(new Error('Browser capture lifecycle is already reserved'))
    }
    const reservation: BrowserCaptureReservation = Object.freeze({
      id: Symbol('browser-capture-reservation'),
      release: () => {
        if (state.reservation !== reservation) {
          return
        }
        if (!this.isIdle(webContents)) {
          throw new Error('Browser capture lifecycle still has pending operations')
        }
        state.reservation = null
        for (const resolve of state.admissionWaiters) {
          resolve()
        }
        state.admissionWaiters.clear()
        this.dropIfUnused(webContents, state)
      }
    })
    state.reservation = reservation
    return this.waitForIdle(webContents).then(() => reservation)
  }

  assertCaptureAllowed(webContents: CaptureTarget, reservation?: BrowserCaptureReservation): void {
    const current = this.states.get(webContents)?.reservation
    if (reservation && current !== reservation) {
      throw new Error('Browser capture lifecycle reservation is not active')
    }
    const active = this.activeOperation.getStore()
    const isPreviouslyAdmittedOperation =
      active?.target === webContents &&
      this.states.get(webContents)?.operations.has(active.identity)
    if (current && current !== reservation) {
      // Why: a command that entered before reserve() recorded its lease may still
      // issue a later raw debugger request. Its async context is valid only while
      // that exact outer operation remains active; timers after return are denied.
      if (isPreviouslyAdmittedOperation) {
        return
      }
      throw new Error('Browser capture is reserved for an owned-view lifecycle transition')
    }
  }

  async runReservedCapture<T>(
    webContents: CaptureTarget,
    reservation: BrowserCaptureReservation,
    operation: (reservation: BrowserCaptureReservation) => Promise<T>
  ): Promise<T> {
    return this.runCapture(webContents, () => operation(reservation), reservation)
  }

  private track<T>(webContents: CaptureTarget, operation: Promise<T>): Promise<T> {
    const state = this.getState(webContents)
    const settled = Promise.resolve(operation)
    state.pending.add(settled)
    void settled.then(
      () => this.settle(webContents, state, settled),
      () => this.settle(webContents, state, settled)
    )
    return settled
  }

  private settle(
    webContents: CaptureTarget,
    state: CaptureState,
    operation: Promise<unknown>
  ): void {
    state.pending.delete(operation)
    this.notifyIfIdle(webContents, state)
  }

  private notifyIfIdle(webContents: CaptureTarget, state: CaptureState): void {
    if (state.pending.size || state.operations.size) {
      return
    }
    for (const resolve of state.waiters) {
      resolve()
    }
    state.waiters.clear()
    this.dropIfUnused(webContents, state)
  }

  private getState(webContents: CaptureTarget): CaptureState {
    const existing = this.states.get(webContents)
    if (existing) {
      return existing
    }
    const state: CaptureState = {
      pending: new Set(),
      operations: new Set(),
      waiters: new Set(),
      admissionWaiters: new Set(),
      reservation: null
    }
    this.states.set(webContents, state)
    return state
  }

  private dropIfUnused(webContents: CaptureTarget, state: CaptureState): void {
    if (
      !state.pending.size &&
      !state.operations.size &&
      !state.reservation &&
      !state.waiters.size &&
      !state.admissionWaiters.size
    ) {
      this.states.delete(webContents)
    }
  }
}

export const browserCaptureIdle = new BrowserCaptureIdle()

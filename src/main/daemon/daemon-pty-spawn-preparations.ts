import { TerminalAttachCanceledError } from './types'

export type PendingPtySpawnPreparation = {
  canceled: boolean
  // Unlike the polled canceled flag, the signal interrupts in-flight cwd probes on dead shares.
  readonly controller: AbortController
  cancelTimer?: ReturnType<typeof setTimeout>
  // Session IDs can be shared; disconnect cancels only this client's preparations.
  clientId: string
  requestId: string
}

export class DaemonPtySpawnPreparations {
  private readonly pending = new Map<string, Set<PendingPtySpawnPreparation>>()
  private readonly cancellationByPreparation = new WeakMap<
    PendingPtySpawnPreparation,
    { promise: Promise<void>; resolve: () => void }
  >()

  constructor(private readonly preparePtySpawn: () => Promise<void>) {}

  register(
    sessionId: string,
    clientId: string,
    requestId: string,
    cancelAfterMs: unknown
  ): PendingPtySpawnPreparation {
    const preparation: PendingPtySpawnPreparation = {
      canceled: false,
      controller: new AbortController(),
      clientId,
      requestId
    }
    let resolveCancellation!: () => void
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve
    })
    this.cancellationByPreparation.set(preparation, {
      promise: cancellation,
      resolve: resolveCancellation
    })
    if (Number.isSafeInteger(cancelAfterMs) && Number(cancelAfterMs) > 0) {
      preparation.cancelTimer = setTimeout(
        () => this.cancelPreparation(preparation),
        Math.min(Number(cancelAfterMs), 300_000)
      )
      preparation.cancelTimer.unref()
    }
    const pendingForSession = this.pending.get(sessionId) ?? new Set()
    pendingForSession.add(preparation)
    this.pending.set(sessionId, pendingForSession)
    return preparation
  }

  async prepareUnlessCanceled(
    sessionId: string,
    preparation: PendingPtySpawnPreparation
  ): Promise<void> {
    // Return protocol cancellation before shutdown tears down the client transport.
    const cancellation = this.cancellationByPreparation.get(preparation)
    const preparationTask = cancellation
      ? Promise.race([this.preparePtySpawn(), cancellation.promise])
      : this.preparePtySpawn()
    await preparationTask
    if (preparation.canceled) {
      throw new TerminalAttachCanceledError(sessionId)
    }
  }

  finish(sessionId: string, preparation: PendingPtySpawnPreparation): void {
    if (preparation.cancelTimer) {
      clearTimeout(preparation.cancelTimer)
    }
    this.cancellationByPreparation.delete(preparation)
    const pendingForSession = this.pending.get(sessionId)
    pendingForSession?.delete(preparation)
    if (pendingForSession?.size === 0) {
      this.pending.delete(sessionId)
    }
  }

  cancel(sessionId: string, request?: { clientId: string; requestId?: string }): boolean {
    const pendingForSession = this.pending.get(sessionId)
    if (!pendingForSession) {
      return false
    }
    let canceled = false
    for (const preparation of pendingForSession) {
      if (
        request &&
        (preparation.clientId !== request.clientId ||
          (request.requestId !== undefined && preparation.requestId !== request.requestId))
      ) {
        continue
      }
      this.cancelPreparation(preparation)
      canceled = true
    }
    return canceled
  }

  cancelForClient(clientId: string): void {
    for (const pendingForSession of this.pending.values()) {
      for (const preparation of pendingForSession) {
        if (preparation.clientId === clientId) {
          this.cancelPreparation(preparation)
        }
      }
    }
  }
  private cancelPreparation(preparation: PendingPtySpawnPreparation): void {
    preparation.canceled = true
    preparation.controller.abort()
    this.cancellationByPreparation.get(preparation)?.resolve()
  }

  cancelAll(): void {
    for (const sessionId of this.pending.keys()) {
      this.cancel(sessionId)
    }
  }
}

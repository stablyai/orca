import type { PromptResponse } from '../generated/acp-protocol.generated'
import { acpPromptTurnId, type AcpPromptOpening } from '../timeline/acp-prompt-turns'
import { AcpAgentError, AcpConnectionClosedError } from '../transport/acp-errors'
import {
  openAcpPromptTurn,
  rejectAcpPreOpenSend,
  sendAcpTurnPrompt,
  settleAcpActiveAgentFailure,
  settleAcpUnexpectedError,
  type AcpInFlightTurn,
  type AcpTurnSettlementSink
} from './acp-structured-turn-settlement'
import type { AcpStructuredTurnsDeps, AcpTurnSend } from './acp-turn-dispatch-contract'

export type AcpTurnFlightContext = {
  deps: AcpStructuredTurnsDeps
  sink: AcpTurnSettlementSink
  isEnded: () => boolean
  isStopped: () => boolean
  isPreparingSteers: () => boolean
  markEnded: () => void
  clearStop: () => void
  advanceSteers: () => void
  notifyIdle: () => void
}

/** Owns the active prompt and at most one overlapping steer on the wire. */
export class AcpTurnFlight {
  active: AcpInFlightTurn | null = null
  steering: AcpInFlightTurn | null = null
  steerCancelled: AcpTurnSend | null = null
  cancelPromoted = false

  constructor(private readonly ctx: AcpTurnFlightContext) {}

  get running(): boolean {
    return this.active !== null || this.steering !== null
  }

  private get promptSteers(): boolean {
    return this.ctx.deps.dialect?.promptSteers === true
  }

  canPromptSteer(): boolean {
    return (
      this.promptSteers &&
      this.active !== null &&
      this.active.sent &&
      !this.active.send.adopted &&
      this.steering === null &&
      !this.ctx.isStopped() &&
      this.steerCancelled !== this.active.send &&
      !this.ctx.isPreparingSteers() &&
      !this.ctx.isEnded()
    )
  }

  start(send: AcpTurnSend): void {
    this.ctx.clearStop()
    this.cancelPromoted = false
    const entry: AcpInFlightTurn = { send, sent: false }
    this.active = entry
    const opened = openAcpPromptTurn(this.ctx.deps.lane, send)
    this.send(entry, opened.promptId)
    this.advanceActive(entry)
  }

  startCompact(send: AcpTurnSend, promptId: string): void {
    this.ctx.clearStop()
    this.cancelPromoted = false
    const entry: AcpInFlightTurn = { send, sent: false }
    this.active = entry
    this.send(entry, promptId)
    this.advanceActive(entry)
  }

  adoptEarlier(
    id: string,
    answered: () => Promise<PromptResponse>,
    ...opening: AcpPromptOpening
  ): void {
    const at = this.ctx.deps.now()
    const opened = this.ctx.deps.lane.translator.openPrompt(id, at, ...opening)
    this.ctx.deps.lane.apply(opened.events)
    const entry: AcpInFlightTurn = {
      send: { clientMessageId: id, prompt: [], requestedAt: at, adopted: true },
      sent: true
    }
    this.active = entry
    this.send(entry, opened.promptId, answered())
    this.advanceActive(entry)
  }

  launchSteer(send: AcpTurnSend): void {
    const entry: AcpInFlightTurn = { send, sent: false }
    this.steering = entry
    this.send(entry, acpPromptTurnId(send.clientMessageId))
  }

  cancelForSteer(): void {
    const send = this.active?.send
    if (!send) {
      return
    }
    this.ctx.deps.withdrawRequests()
    if (this.steerCancelled === send) {
      return
    }
    this.steerCancelled = send
    this.ctx.deps.connection.cancel().catch(() => {
      // A failed write lets the next steer retry.
      if (this.steerCancelled === send) {
        this.steerCancelled = null
      }
    })
  }

  private send(entry: AcpInFlightTurn, promptId: string, earlier?: Promise<PromptResponse>): void {
    sendAcpTurnPrompt(
      this.ctx.deps,
      entry,
      promptId,
      {
        onResult: (result) => this.onResult(entry, result),
        onError: (error) => this.onError(entry, error)
      },
      earlier
    )
  }

  private advanceActive(entry: AcpInFlightTurn): void {
    if (this.active !== entry || this.ctx.isEnded()) {
      return
    }
    if (this.ctx.isPreparingSteers()) {
      this.cancelForSteer()
    } else {
      this.ctx.advanceSteers()
    }
  }

  private promote(entry: AcpInFlightTurn): void {
    this.active = entry
    openAcpPromptTurn(this.ctx.deps.lane, entry.send)
    const interrupted = this.cancelPromoted
    this.cancelPromoted = false
    if (entry.settled) {
      if (interrupted) {
        this.steerCancelled = entry.send
      }
      const settled = entry.settled
      entry.settled = undefined
      if (settled.ok) {
        this.onResult(entry, settled.result)
      } else {
        this.onError(entry, settled.error)
      }
      return
    }
    if (this.ctx.isStopped()) {
      // Re-issue cancel in case the first notification landed before the agent picked up this prompt.
      this.ctx.deps.withdrawRequests()
      void this.ctx.deps.connection.cancel().catch(() => undefined)
      return
    }
    if (interrupted || this.ctx.isPreparingSteers()) {
      this.cancelForSteer()
      return
    }
    this.ctx.advanceSteers()
    this.ctx.notifyIdle()
  }

  private onResult(entry: AcpInFlightTurn, result: PromptResponse): void {
    if (this.steering === entry) {
      entry.settled = { ok: true, result }
      return
    }
    if (this.active !== entry) {
      return
    }
    const { lane, now } = this.ctx.deps
    const cancelled = this.ctx.isStopped() || this.steerCancelled === entry.send
    const { clientMessageId } = entry.send
    lane.apply(lane.translator.promptResult(clientMessageId, result, now(), cancelled))
    this.ctx.sink.accept(clientMessageId)
    this.finish(entry, lane.translator.failures.takeSessionLoss())
  }

  private onError(entry: AcpInFlightTurn, error: unknown): void {
    if (error instanceof AcpConnectionClosedError) {
      // Connection teardown owns unknown-send settlement.
      return
    }
    if (this.steering === entry) {
      this.onSteerError(entry, error)
      return
    }
    if (this.active !== entry) {
      return
    }
    if (!(error instanceof AcpAgentError)) {
      // Unreadable replies fail the turn but allow the next send.
      settleAcpUnexpectedError(this.ctx.deps, entry.send.clientMessageId, error)
      this.ctx.sink.accept(entry.send.clientMessageId)
      this.finish(entry)
      return
    }
    const loss = settleAcpActiveAgentFailure(this.ctx.deps, this.ctx.sink, entry.send, error)
    this.finish(entry, loss)
  }

  private onSteerError(entry: AcpInFlightTurn, error: unknown): void {
    if (!(error instanceof AcpAgentError)) {
      entry.settled = { ok: false, error }
      return
    }
    this.steering = null
    rejectAcpPreOpenSend(this.ctx.deps, this.ctx.sink, entry.send.clientMessageId, error)
    if (this.ctx.deps.lane.translator.sessionLost(error)) {
      this.ctx.markEnded()
      this.ctx.notifyIdle()
      this.ctx.deps.sessionLost(error)
      return
    }
    this.ctx.advanceSteers()
    this.ctx.notifyIdle()
  }

  private finish(entry: AcpInFlightTurn, sessionLoss?: Error): void {
    if (sessionLoss) {
      // Held steers must not reach the dead session.
      this.ctx.markEnded()
    }
    if (this.active === entry) {
      this.active = null
    }
    if (this.steerCancelled === entry.send) {
      this.steerCancelled = null
    }
    if (this.ctx.isEnded()) {
      this.ctx.clearStop()
      this.cancelPromoted = false
      this.ctx.notifyIdle()
      if (sessionLoss) {
        this.ctx.deps.sessionLost(sessionLoss)
      }
      return
    }
    if (this.steering) {
      const promoted = this.steering
      this.steering = null
      this.promote(promoted)
      return
    }
    this.ctx.clearStop()
    this.cancelPromoted = false
    this.ctx.advanceSteers()
    this.ctx.notifyIdle()
  }
}

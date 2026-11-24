import type { PromptResponse } from '../generated/acp-protocol.generated'
import { acpPromptTurnId } from '../timeline/acp-prompt-turns'
import { AcpAgentError, AcpConnectionClosedError } from '../transport/acp-errors'
import {
  rejectAcpPreOpenSend,
  settleAcpActiveAgentFailure,
  settleAcpUnexpectedError,
  type AcpInFlightTurn,
  type AcpTurnSend
} from './acp-structured-turn-settlement'
import type { AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'

export function openAcpPromptTurn(
  lane: AcpStructuredTurnsDeps['lane'],
  send: AcpTurnSend
): { promptId: string } {
  lane.agentTurn.end()
  const opened = lane.translator.openPrompt(send.clientMessageId, send.requestedAt)
  lane.apply(opened.events)
  return opened
}

export function sendAcpTurnPrompt(
  deps: Pick<AcpStructuredTurnsDeps, 'connection' | 'lane'>,
  entry: AcpInFlightTurn,
  promptId: string,
  handlers: {
    onResult: (result: PromptResponse) => void
    onError: (error: unknown) => void
  }
): void {
  const meta = deps.lane.translator.injectsPromptIdentity
    ? { promptId, requestId: promptId }
    : undefined
  let settled = false
  const onResult = (result: PromptResponse): void => {
    if (settled) {
      return
    }
    settled = true
    handlers.onResult(result)
  }
  // Handle responses synchronously so steering promotes before later updates in the same chunk.
  const answered = deps.connection.prompt(entry.send.prompt, meta, onResult)
  entry.sent = true
  answered.then(onResult, (error: unknown) => {
    if (settled) {
      return
    }
    settled = true
    handlers.onError(error)
  })
}

export type AcpTurnFlightContext = {
  deps: AcpStructuredTurnsDeps
  unsettled: Set<string>
  isEnded: () => boolean
  isStopped: () => boolean
  isPreparingSteers: () => boolean
  markEnded: () => void
  clearStop: () => void
  accept: (clientMessageId: string) => void
  notifyIdle: () => void
}

/** Owns the active prompt, at most one overlapping steer on the wire, and queued follow-up steers. */
export class AcpTurnFlight {
  active: AcpInFlightTurn | null = null
  steering: AcpInFlightTurn | null = null
  steerCancelled: AcpTurnSend | null = null
  cancelPromoted = false
  readonly steers: AcpTurnSend[] = []

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
      if (this.steerCancelled === send) {
        this.steerCancelled = null
      }
    })
  }

  private send(entry: AcpInFlightTurn, promptId: string): void {
    sendAcpTurnPrompt(this.ctx.deps, entry, promptId, {
      onResult: (result) => this.onResult(entry, result),
      onError: (error) => this.onError(entry, error)
    })
  }

  private advanceActive(entry: AcpInFlightTurn): void {
    if (this.active !== entry || this.ctx.isEnded()) {
      return
    }
    if (this.ctx.isPreparingSteers()) {
      this.cancelForSteer()
    } else if (this.steers.length > 0) {
      if (this.canPromptSteer()) {
        this.launchNextSteer()
      } else if (!this.promptSteers) {
        this.cancelForSteer()
      }
    }
  }

  private promote(entry: AcpInFlightTurn): void {
    this.active = entry
    openAcpPromptTurn(this.ctx.deps.lane, entry.send)
    if (entry.settled) {
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
    if (this.cancelPromoted || this.ctx.isPreparingSteers()) {
      this.cancelPromoted = false
      this.cancelForSteer()
      return
    }
    this.launchNextSteer()
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
    this.ctx.accept(clientMessageId)
    this.finish(entry, lane.translator.failures.takeSessionLoss())
  }

  private onError(entry: AcpInFlightTurn, error: unknown): void {
    if (error instanceof AcpConnectionClosedError) {
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
      settleAcpUnexpectedError(this.ctx.deps, entry.send.clientMessageId, error)
      this.ctx.accept(entry.send.clientMessageId)
      this.finish(entry)
      return
    }
    const loss = settleAcpActiveAgentFailure(
      this.ctx.deps,
      this.ctx.unsettled,
      entry.send.clientMessageId,
      error
    )
    this.finish(entry, loss)
  }

  private onSteerError(entry: AcpInFlightTurn, error: unknown): void {
    if (!(error instanceof AcpAgentError)) {
      entry.settled = { ok: false, error }
      return
    }
    this.steering = null
    rejectAcpPreOpenSend(this.ctx.deps, this.ctx.unsettled, entry.send.clientMessageId, error)
    if (this.ctx.deps.lane.translator.sessionLost(error)) {
      this.ctx.markEnded()
      this.ctx.deps.sessionLost(error)
      return
    }
    this.launchNextSteer()
  }

  private finish(entry: AcpInFlightTurn, sessionLoss?: Error): void {
    if (sessionLoss) {
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
      if (!this.running) {
        this.ctx.notifyIdle()
      }
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
    const next = this.steers.shift()
    if (next) {
      this.start(next)
    } else if (!this.active) {
      this.ctx.notifyIdle()
    }
  }

  private launchNextSteer(): void {
    if (this.steers.length > 0 && this.canPromptSteer()) {
      const next = this.steers.shift()
      if (next) {
        this.launchSteer(next)
      }
    }
  }
}

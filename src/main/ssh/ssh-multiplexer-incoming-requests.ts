import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { JsonRpcRequest, JsonRpcResponse } from './relay-protocol'
import type { MultiplexerWriteSettlement } from './ssh-multiplexer-transport-writer'
import { SshMultiplexerSettlementBarrier } from './ssh-multiplexer-settlement-barrier'
import { assertProfileLifetimeAdmission } from './profile-lifetime-admission'

type Settlement = { ok: true } | { ok: false; error: Error }
type SendResponse = (
  response: JsonRpcResponse,
  onSettled: (result: MultiplexerWriteSettlement) => void
) => void

/** Separate from outgoing drains: a CLI handler may itself await an ordinary migration drain. */
export class SshMultiplexerIncomingRequests {
  private readonly pending = new Set<object>()
  private readonly barrier = new SshMultiplexerSettlementBarrier()
  private readonly lifetime = new AbortController()
  private resetDrain: Promise<Settlement> | null = null
  private resetResult: Settlement | undefined

  fenceForReset(): void {
    if (!this.resetDrain) {
      // Snapshot at the fence, so failures before the first observation remain failures on retry.
      this.resetDrain = this.barrier.wait(this.lifetime.signal).then(
        () => (this.resetResult = { ok: true }),
        (error: unknown) => (this.resetResult = { ok: false, error: asError(error) })
      )
    }
  }

  async waitForReset(signal: AbortSignal): Promise<void> {
    if (!this.resetDrain) {
      throw new Error('relay_reset_incoming_admission_not_closed')
    }
    const result = await waitForPromiseWithSignal(this.resetDrain, signal)
    if (!result.ok) {
      throw result.error
    }
    this.lifetime.signal.throwIfAborted()
  }

  assertResetDrained(): void {
    this.lifetime.signal.throwIfAborted()
    if (!this.resetResult) {
      throw new Error('relay_reset_incoming_drain_unconfirmed')
    }
    if (!this.resetResult.ok) {
      throw this.resetResult.error
    }
    this.barrier.assertSettled()
  }

  dispose(error: Error): void {
    this.lifetime.abort(error)
    for (const token of this.pending) {
      this.barrier.settle(token, { ok: false, error })
    }
    this.pending.clear()
  }

  async dispatch(
    message: JsonRpcRequest,
    handler: ((params: Record<string, unknown>) => unknown) | undefined,
    send: SendResponse
  ): Promise<void> {
    const token = {}
    const admitted = !this.resetDrain && !this.lifetime.signal.aborted
    if (admitted) {
      this.pending.add(token)
      this.barrier.retain(token)
    }
    const finish = (result: Settlement) => {
      if (this.pending.delete(token)) {
        this.barrier.settle(token, result)
      }
    }
    const respond = (response: JsonRpcResponse, result: Settlement) => {
      try {
        send(response, (settlement) => {
          finish(
            settlement.outcome === 'accepted' ? result : { ok: false, error: settlement.error }
          )
        })
      } catch (error) {
        const failure = asError(error)
        try {
          send(
            { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: failure.message } },
            (settlement) =>
              finish({
                ok: false,
                error: settlement.outcome === 'accepted' ? failure : settlement.error
              })
          )
        } catch {
          finish({ ok: false, error: failure })
        }
      }
    }
    const reject = (error: Error, code: number) =>
      respond(
        {
          jsonrpc: '2.0',
          id: message.id,
          error: { code, message: error.message }
        },
        { ok: false, error }
      )
    if (!admitted) {
      reject(new Error('relay_reset_work_admission_closed'), -32000)
      return
    }
    if (!handler) {
      reject(new Error(`Method not found: ${message.method}`), -32601)
      return
    }
    try {
      assertProfileLifetimeAdmission()
      const result = await handler(message.params ?? {})
      respond({ jsonrpc: '2.0', id: message.id, result: result ?? null }, { ok: true })
    } catch (error) {
      reject(asError(error), (error as { code?: number })?.code ?? -32000)
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

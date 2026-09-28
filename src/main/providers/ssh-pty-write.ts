import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { encodeJsonRpcFrame, TIMEOUT_MS } from '../ssh/relay-protocol'
import {
  MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES,
  toWriteSettlement
} from '../ssh/ssh-multiplexer-transport-writer'
import {
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

// Allow ordinary-lane backpressure to clear well beyond the mux health window.
export const SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS = TIMEOUT_MS * 3

export function assertSshPtyWriteFitsTransport(relayPtyId: string, data: string): void {
  const frame = encodeJsonRpcFrame(
    { jsonrpc: '2.0', method: 'pty.data', params: { id: relayPtyId, data } },
    0,
    0
  )
  if (frame.length > MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES) {
    throw new Error(
      `SSH PTY input exceeds the ${MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES}-byte transport limit`
    )
  }
}

export function writeToSshPty(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  data: string
): boolean {
  if (mux.isDisposed()) {
    return false
  }
  try {
    assertSshPtyWriteFitsTransport(relayPtyId, data)
  } catch {
    return false
  }
  mux.notify('pty.data', { id: relayPtyId, data })
  return !mux.isDisposed()
}

/**
 * Three-valued: a pre-write refusal is proven, a lost or timed-out settlement is
 * `unverifiable` with the handoff fact attached. Neither is ever flattened to a boolean.
 */
export function writeToSshPtyWithSettlement(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  data: string
): Promise<WriteSettlement> {
  if (mux.isDisposed()) {
    return Promise.resolve(writeRefused('transport_disposed'))
  }
  try {
    assertSshPtyWriteFitsTransport(relayPtyId, data)
  } catch {
    return Promise.resolve(writeRefused('payload_exceeds_transport_limit'))
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (settlement: WriteSettlement): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(settlement)
    }
    const timer = setTimeout(() => {
      mux.dispose('connection_lost')
      finish(writeUnverifiable('settlement_timeout', true))
    }, SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS)
    timer.unref?.()
    mux.notifyWithSettlement('pty.data', { id: relayPtyId, data }, (result) =>
      finish(toWriteSettlement(result))
    )
  })
}

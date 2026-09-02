import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { encodeJsonRpcFrame, TIMEOUT_MS } from '../ssh/relay-protocol'
import { MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES } from '../ssh/ssh-multiplexer-transport-writer'

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

export function writeToSshPtyWithSettlement(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  data: string
): Promise<boolean> {
  if (mux.isDisposed()) {
    return Promise.resolve(false)
  }
  try {
    assertSshPtyWriteFitsTransport(relayPtyId, data)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (accepted: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(accepted)
    }
    const timer = setTimeout(() => {
      mux.dispose('connection_lost')
      finish(false)
    }, SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS)
    timer.unref?.()
    mux.notifyWithSettlement('pty.data', { id: relayPtyId, data }, (result) => finish(result.ok))
  })
}

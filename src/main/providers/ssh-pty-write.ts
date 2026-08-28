import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { TIMEOUT_MS } from '../ssh/relay-protocol'

// Allow ordinary-lane backpressure to clear well beyond the mux health window.
export const SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS = TIMEOUT_MS * 3

export function writeToSshPty(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  data: string
): boolean {
  if (mux.isDisposed()) {
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

import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { toRelaySshPtyId } from './ssh-pty-id'

type AppliedPtySize = { cols: number; rows: number }
// Why: wake repair can safely re-forward on failure, so never inherit the generic 30-second RPC timeout.
const SSH_PTY_APPLIED_SIZE_TIMEOUT_MS = 1_000

export function createSshPtyAppliedSizeReader(
  mux: SshChannelMultiplexer,
  connectionId: string
): (id: string) => Promise<AppliedPtySize | null> {
  let supported: boolean | null = null
  return async (id) => {
    if (supported === false) {
      return null
    }
    try {
      const result = (await mux.request(
        'pty.getSize',
        {
          id: toRelaySshPtyId(connectionId, id)
        },
        { timeoutMs: SSH_PTY_APPLIED_SIZE_TIMEOUT_MS }
      )) as {
        cols?: unknown
        rows?: unknown
      } | null
      supported = true
      if (
        !result ||
        !Number.isInteger(result.cols) ||
        !Number.isInteger(result.rows) ||
        Number(result.cols) <= 0 ||
        Number(result.rows) <= 0
      ) {
        return null
      }
      return { cols: Number(result.cols), rows: Number(result.rows) }
    } catch (error) {
      if ((error as { code?: unknown })?.code === JsonRpcErrorCode.MethodNotFound) {
        // Why: old relays lack pty.getSize; remember that per SSH provider so
        // each wake re-forwards once without repeatedly probing the same host.
        supported = false
      }
      return null
    }
  }
}

import { readTerminalSendAcknowledgment } from '../../shared/terminal-send-acknowledgment'
import type { OrcaRuntimeService } from './orca-runtime'

/** `refused` with no `error` property: the fence passed and the host then refused the write. */
export type FencedAgentKeysOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; error?: unknown }
  | { outcome: 'unknown' }

/**
 * Keys for an agent's own UI (an answer, an interrupt), without Enter. `fence` runs last before
 * the write and throws to refuse; once it passed, a failure may have written, so it is `unknown`.
 */
export async function writeFencedAgentKeys(
  runtime: Pick<OrcaRuntimeService, 'sendTerminal'>,
  handle: string,
  keys: string,
  options: {
    beforeWrite?: (ptyId: string) => Promise<void>
    fence: (ptyId: string) => void
    signal: AbortSignal
  }
): Promise<FencedAgentKeysOutcome> {
  let fenced = false
  try {
    const sent = await runtime.sendTerminal(
      handle,
      { text: keys, enter: false },
      {
        inputKind: 'driving',
        signal: options.signal,
        requireWriteSettlement: true,
        beforeWrite: options.beforeWrite,
        reserveWrite: (ptyId) => {
          options.fence(ptyId)
          fenced = true
        }
      }
    )
    const settlement = readTerminalSendAcknowledgment({ send: sent })
    return settlement === 'accepted' || settlement === 'refused'
      ? { outcome: settlement }
      : { outcome: 'unknown' }
  } catch (error) {
    return fenced ? { outcome: 'unknown' } : { outcome: 'refused', error }
  }
}

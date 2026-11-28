import { RexStreamParser } from './rex-stream-parser'
import type { RexFreshSession } from './rex-fresh-session'
import type { IPtyProvider } from '../pty/provider-contract'
import type { PtyDataEvent } from '../pty/events'

export function createRexSessionParser(
  session: RexFreshSession,
  nonce: bigint,
  dataCallbacks: Set<(event: PtyDataEvent) => void>,
  exitCallbacks: Set<Parameters<IPtyProvider['onExit']>[0]>,
  onNaturalExit: () => void
): RexStreamParser {
  return new RexStreamParser(
    nonce,
    (text) => {
      for (const callback of dataCallbacks) {
        callback({ id: session.id, data: text })
      }
    },
    (metadata) => {
      // Never pass Rex transport metadata into the terminal as child output.
      if (typeof metadata !== 'object' || metadata === null) {
        throw new Error('Invalid Rex metadata')
      }
      const event = metadata
      if (
        'type' in event &&
        event.type === 'child_exited' &&
        'exit_code' in event &&
        typeof event.exit_code === 'number' &&
        Number.isInteger(event.exit_code) &&
        session.exitCode === undefined
      ) {
        session.exitCode = event.exit_code
        for (const callback of exitCallbacks) {
          callback({
            id: session.id,
            code: event.exit_code,
            incarnationId: session.record.incarnationId
          })
        }
        onNaturalExit()
      }
    }
  )
}

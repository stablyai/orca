/**
 * Office preview on an SSH host.
 *
 * The relay is bundle-hash-locked to its client — a mismatched client is refused at handshake — so
 * this handler needs no capability negotiation: client and relay are always the same build. That
 * is the one structural difference from the paired-runtime path, which does face mixed versions.
 *
 * Everything else is `executeOfficeMethod`, byte for byte the implementation the client's own
 * `local` host runs. `officecli` runs here, on the machine that owns the document, with this
 * machine's fonts and locale — never on the client as a substitute.
 */
import { executeOfficeMethod } from '../main/office/office-method-executor'
import { stopAllOfficeWatches } from '../main/office/office-watch-manager'
import { OFFICE_RPC_METHODS } from '../shared/office-preview-rpc'
import type { RelayDispatcher } from './dispatcher'

export class OfficeHandler {
  constructor(dispatcher: Pick<RelayDispatcher, 'onRequest'>) {
    for (const method of OFFICE_RPC_METHODS) {
      dispatcher.onRequest(method, async (params: unknown) => executeOfficeMethod(method, params))
    }
  }

  /**
   * Teardown for the relay going down. A watch process outlives its client by design — it is
   * detached — so nothing else would ever stop it, and it would hold a port and a file on this
   * host until someone noticed.
   */
  async shutdown(): Promise<void> {
    await stopAllOfficeWatches()
  }
}

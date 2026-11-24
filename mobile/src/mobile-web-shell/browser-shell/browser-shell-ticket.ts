import type { PairingOffer } from '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { exchangePairingTicket } from '../../pairing/pairing-ticket-exchange'
import { connect } from '../../transport/rpc/direct-rpc-connect'
import { readProbedHostStatus } from '../../transport/connection/host-status-probe-operations'

const EXCHANGE_TIMEOUT_MS = 15_000

/**
 * Swaps the link's pairing code for a token made in this browser, as the app does after a scan,
 * so the printed link stops working once this tab signs in. Any failure keeps the link's code,
 * which the desktop still accepts.
 */
export async function exchangeBrowserShellTicket(
  offer: PairingOffer,
  hostId: string
): Promise<PairingOffer> {
  const client = connect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, { hostId })
  const log = (level: string, message: string, detail?: string) => {
    console.warn('[browser-shell]', level, message, detail ?? '')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('pairing exchange timed out')), EXCHANGE_TIMEOUT_MS)
  })
  try {
    const status = readProbedHostStatus(
      await Promise.race([client.sendRequest('status.get'), timeout])
    )?.status
    const deviceToken = await Promise.race([
      exchangePairingTicket({ client, status: status ?? null, ticket: offer.deviceToken, log }),
      timeout
    ])
    return { ...offer, deviceToken }
  } catch (error) {
    log('info', 'Keeping the link pairing code', String(error))
    return offer
  } finally {
    clearTimeout(timer)
    client.close()
  }
}

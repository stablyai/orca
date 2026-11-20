import type { ConnectorOfferSource } from '../../../../../src/shared/bots/bot-connector-offer'
import type { ListedConnectorStatus } from '../../../bots/host-bots-operations'

/** The Connect card says Paused instead of Connected while this host is signed out of Orca Cloud.
 *  Google keeps the owner's own toggle. An older host, which sends no status, keeps today's line. */
export function connectorOfferCloudPaused(
  source: ConnectorOfferSource,
  status: ListedConnectorStatus | undefined
): boolean {
  if (source === 'google' || status === undefined) {
    return false
  }
  return status === 'signed-out'
}

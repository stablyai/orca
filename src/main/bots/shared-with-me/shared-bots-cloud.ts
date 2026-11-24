// The teammate's side of the shares routes on Orca Cloud: the agents shared with this account, an
// accept for one, and a message held for a host that is away.
import {
  ConnectorShareAcceptSchema,
  ConnectorShareHoldSchema,
  ConnectorSharesMineSchema,
  type ConnectorShareAcceptRequest,
  type ConnectorShareHoldRequest
} from '../../../../cloud/packages/connector-contract/src/share-messages'
import { CONNECTOR_PATHS } from '../../../shared/connectors/connector-cloud-paths'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'

const sharePath = (shareId: string, tail: string): string =>
  `${CONNECTOR_PATHS.shares}/${encodeURIComponent(shareId)}/${tail}`

export function sharedBotsCloud(cloud: Pick<ConnectorCloud, 'call'>) {
  return {
    mine: () =>
      cloud.call(`${CONNECTOR_PATHS.shares}/mine`, undefined, ConnectorSharesMineSchema, {
        method: 'GET'
      }),
    accept: (shareId: string, request: ConnectorShareAcceptRequest) =>
      cloud.call(sharePath(shareId, 'accept'), request, ConnectorShareAcceptSchema),
    hold: (shareId: string, request: ConnectorShareHoldRequest) =>
      cloud.call(sharePath(shareId, 'messages'), request, ConnectorShareHoldSchema)
  }
}

export type SharedBotsCloud = ReturnType<typeof sharedBotsCloud>

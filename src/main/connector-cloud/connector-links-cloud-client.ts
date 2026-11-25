// The signed-in account's linked Slack, GitHub and Linear people in Orca Cloud.
import { z } from 'zod'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_LINKS_OFF,
  ConnectorLinksResponseSchema,
  type ConnectorLinkKey
} from '../../shared/connectors/connector-links-contract'
import { offAnswer } from './bots-cloud-answer'
import type { ConnectorCloud } from './connector-cloud'

// A cloud from before linked accounts has no route; a 404 with a code (not_linked) is that code.
const linksAnswer = offAnswer(CONNECTOR_LINKS_OFF)

export function connectorLinksClient(cloud: Pick<ConnectorCloud, 'call'>) {
  return {
    list: async () =>
      linksAnswer(
        await cloud.call(CONNECTOR_PATHS.links, undefined, ConnectorLinksResponseSchema, {
          method: 'GET'
        })
      ),
    /** One of the account's own links; the others stay. */
    unlink: async ({ source, workspaceId, userId }: ConnectorLinkKey) =>
      linksAnswer(
        await cloud.call(
          `${CONNECTOR_PATHS.links}/${[source, workspaceId, userId].map(encodeURIComponent).join('/')}`,
          undefined,
          z.undefined(),
          { method: 'DELETE' }
        )
      )
  }
}

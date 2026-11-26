import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import { postConnectorAction } from '../connector-cloud/connector-actions'
import type { ConnectorTransport } from '../connector-cloud/connector-machine'
import type { ReadConnectorImage } from './connector-asker-images'

export function connectorImageReader(
  transport?: ConnectorTransport | null
): ReadConnectorImage | null {
  return transport
    ? async ({ botId, ref, fileId, conversation }, signal) => {
        const about = cloudConversation(conversation)
        return await postConnectorAction(
          transport,
          {
            botId,
            verb: 'read',
            ref,
            args: { download: fileId, stream: true },
            ...(about ? { conversation: about } : {})
          },
          signal
        )
      }
    : null
}

import { JsonlRpcAgentConnection } from '../../../jsonl-rpc/agent-connection'
import type { ProviderProcessLaunch } from '../../../provider-process/provider-process-launch'

export function connectPiCatalog(launch: ProviderProcessLaunch): JsonlRpcAgentConnection {
  const connection: JsonlRpcAgentConnection = new JsonlRpcAgentConnection(launch, {
    // Cancel dialogs after binding; Pi cannot read replies to session_start dialogs before binding.
    onRecord: (frame) => {
      if (
        frame.type === 'extension_ui_request' &&
        (typeof frame.id === 'string' || typeof frame.id === 'number')
      ) {
        void connection
          .send({ type: 'extension_ui_response', id: frame.id, cancelled: true })
          .catch(() => undefined)
      }
    }
  })
  return connection
}

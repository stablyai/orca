import { HOME_AGENTS_ROUTE_GRANT } from '../navigation/home-agents-route'
import { usePageBridgeClient } from '../transport/connection/client-context.web'

// Read during render: init precedes mount and grants stay fixed for the document's life.
export function useHomeAgentsLink(): boolean {
  const client = usePageBridgeClient()
  return client.getShellSession()?.grants.native.includes(HOME_AGENTS_ROUTE_GRANT) === true
}

import { usePageBridgeClient } from '../transport/connection/client-context.web'
import { servedHere } from './route-handoff.web'

// A hop the shell takes opens the list in another document, which cannot see this page's in-memory intents.
export function useHostListInThisDocument(hostId: string): boolean {
  const client = usePageBridgeClient()
  return hostId !== '' && servedHere(client, `/h/${encodeURIComponent(hostId)}`)
}

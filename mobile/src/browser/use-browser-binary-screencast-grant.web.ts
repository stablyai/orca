import { usePageBridgeClient } from '../transport/client-context.web'

// Use camelCase lane token: manifest GRANT_NAME_PATTERN accepts bare names/native verbs, refusing dotted non-verbs.
const BROWSER_BINARY_SCREENCAST_GRANT = 'screencastBinary'

// Read session init grants once at render (entry waits for init; grants are immutable).
// Missing encoder grant means stream-error UI; never send wantsBinary to older shell that cannot deliver frames.
export function useBrowserBinaryScreencastGrant(): boolean {
  const client = usePageBridgeClient()
  return client.getShellSession()?.grants.native.includes(BROWSER_BINARY_SCREENCAST_GRANT) === true
}

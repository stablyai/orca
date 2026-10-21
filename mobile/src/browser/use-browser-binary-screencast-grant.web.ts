import { usePageBridgeClient } from '../transport/client-context.web'

/**
 * The name C6.1 gives the binary screencast lane in the shell's implemented set.
 *
 * One camelCase token rather than a dotted path: `GRANT_NAME_PATTERN` in the manifest contract
 * admits a bare name or a `native.`-prefixed verb and nothing else, so a route declaring a dotted
 * non-verb name would be refused by the bundle before it ever reached a shell.
 *
 * Local until C6.1's `bridge/bridge-screencast-grant.ts` reaches main, which becomes the one
 * source both sides read once they have both landed.
 */
const BROWSER_BINARY_SCREENCAST_GRANT = 'screencastBinary'

/**
 * Web sibling: the page asks the shell it is running inside, through the grants `init` gave it.
 *
 * Grants rather than a new `init` field, because a shell built before the encoder must not be sent
 * `wantsBinary` and left holding a subscription no frame will ever arrive on. A shell that does not
 * name this one answers no, and the pane renders its stream-error state rather than a black
 * rectangle that never resolves.
 *
 * Read during render rather than per frame: the page entry waits for `init` before it mounts
 * anything, so the session is already there and its grants do not change for the life of the
 * document.
 */
export function useBrowserBinaryScreencastGrant(): boolean {
  const client = usePageBridgeClient()
  return client.getShellSession()?.grants.native.includes(BROWSER_BINARY_SCREENCAST_GRANT) === true
}

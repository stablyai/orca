import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { BridgeRpcClient } from '../../mobile-web-shell/bridge/client-state/bridge-rpc-client-contract'
import {
  BRIDGE_DIRECT_PAIRINGS_VERB,
  directPairingsResultSchema
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-direct-pairings-verb'

const NONE: ReadonlySet<string> = new Set()

function isPageBridge(
  client: RpcClient
): client is RpcClient & Pick<BridgeRpcClient, 'callNativeVerb' | 'getShellSession'> {
  return (
    'callNativeVerb' in client &&
    typeof client.callNativeVerb === 'function' &&
    'getShellSession' in client &&
    typeof client.getShellSession === 'function'
  )
}

/** The installations this phone pairs with directly, asked of the shell. An older shell offers no
 *  such verb, so nothing is hidden, as before. */
export async function readDirectPairingInstallations(
  client: RpcClient
): Promise<ReadonlySet<string>> {
  if (
    !isPageBridge(client) ||
    client.getShellSession()?.grants.native.includes(BRIDGE_DIRECT_PAIRINGS_VERB) !== true
  ) {
    return NONE
  }
  try {
    const reply = await client.callNativeVerb(BRIDGE_DIRECT_PAIRINGS_VERB, {})
    const parsed = directPairingsResultSchema.safeParse(reply.result)
    return parsed.success ? new Set(parsed.data.installationIds) : NONE
  } catch {
    return NONE
  }
}

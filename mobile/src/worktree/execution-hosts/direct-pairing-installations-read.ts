import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const NONE: ReadonlySet<string> = new Set()

/** Only a page hides relayed copies (the shell answers it from its record); native lists show all. */
export async function readDirectPairingInstallations(
  _client: RpcClient
): Promise<ReadonlySet<string>> {
  return NONE
}

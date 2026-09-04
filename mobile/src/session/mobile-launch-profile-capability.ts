import { AGENT_SESSION_LAUNCH_PROFILE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'

// Why: source the capability string from the shared contract so a host bump can never
// silently drift from the mobile probe.
export const MOBILE_AGENT_LAUNCH_PROFILE_CAPABILITY =
  AGENT_SESSION_LAUNCH_PROFILE_RUNTIME_CAPABILITY

/** Whether the paired host honors `launchProfileId`; older hosts silently ignore unknown fields. */
export async function readAgentLaunchProfileCapability(
  client: Pick<RpcClient, 'sendRequest'>
): Promise<boolean> {
  try {
    const response = await client.sendRequest('status.get')
    if (!response.ok || !response.result || typeof response.result !== 'object') {
      return false
    }
    const capabilities = (response.result as { capabilities?: unknown }).capabilities
    return (
      Array.isArray(capabilities) && capabilities.includes(MOBILE_AGENT_LAUNCH_PROFILE_CAPABILITY)
    )
  } catch {
    return false
  }
}

import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

/** Refuse before an older host strips a param and reports success; an unreachable host proves nothing. */
export async function requireTerminalHostCapability(
  client: RuntimeClient,
  capability: string,
  messages: { unreachable: string; missing: string }
): Promise<void> {
  const status = await client.getCliStatus()
  if (!status.result.runtime.reachable) {
    throw new RuntimeClientError('runtime_unavailable', messages.unreachable)
  }
  if (status.result.runtime.capabilities?.includes(capability) !== true) {
    throw new RuntimeClientError('incompatible_runtime', messages.missing)
  }
}

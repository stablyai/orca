import type { RuntimeCapability } from '../../../shared/protocol-version'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'
import { parseRuntimeClientCapabilities } from './runtime-client-capabilities'

export function parseMobileE2EEV2ClientCapabilities(
  plaintext: string
): readonly RuntimeCapability[] | null {
  try {
    const message = parseRemoteRuntimeJsonText(plaintext) as Record<string, unknown>
    if (
      Object.keys(message).sort().join(',') !== 'clientCapabilities,type,v' ||
      message.type !== 'e2ee_client_capabilities' ||
      message.v !== 1
    ) {
      return null
    }
    return parseRuntimeClientCapabilities(message.clientCapabilities)
  } catch {
    return null
  }
}

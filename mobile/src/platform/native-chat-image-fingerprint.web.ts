import { serializeStructuredAgentSessionFingerprintPayload } from '../../../src/shared/structured-agent-session-mutation'
import { sha256 } from '../../../src/shared/sha256'
import { MOBILE_NATIVE_CHAT_IMAGE_FINGERPRINT_DOMAIN } from '../session/mobile-native-chat-image-attachment'

function fingerprintHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function fingerprintNativeChatImage(base64: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    serializeStructuredAgentSessionFingerprintPayload({
      method: MOBILE_NATIVE_CHAT_IMAGE_FINGERPRINT_DOMAIN,
      sessionId: '',
      fields: { base64 }
    })
  )
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    return fingerprintHex(sha256(bytes))
  }
  try {
    return fingerprintHex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
  } catch {
    // A crypto backend failure must not discard an image the host already saved.
    return fingerprintHex(sha256(bytes))
  }
}

import { deriveSharedKey } from '../../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { parseRemoteRuntimeJsonText } from '../../../../../shared/remote-runtime/requests/remote-runtime-request-frames'
import {
  DesktopMobileE2EEV2Session,
  type DesktopMobileE2EEV2Context
} from './mobile-e2ee-v2-desktop-session'
import { decodeMobileE2EEPublicKey } from './mobile-e2ee-auth-validation'

export function admitMobileE2EEHello(
  raw: string,
  serverSecretKey: Uint8Array,
  expectedContext: DesktopMobileE2EEV2Context,
  requireV2: boolean
) {
  let hello: Record<string, unknown>
  try {
    const parsed = parseRemoteRuntimeJsonText(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Invalid handshake message' } as const
    }
    hello = { ...parsed }
  } catch {
    return { error: 'Invalid handshake message' } as const
  }
  if (hello.type === 'e2ee_hello' && hello.v === 2) {
    const session = DesktopMobileE2EEV2Session.create({ hello, serverSecretKey, expectedContext })
    return session
      ? { session, sharedKey: null, ready: session.ready }
      : ({ error: 'Invalid e2ee_hello v2' } as const)
  }
  if (requireV2) {
    return { error: 'E2EE v2 required' } as const
  }
  if (hello.type !== 'e2ee_hello' || typeof hello.publicKeyB64 !== 'string') {
    return { error: 'Invalid e2ee_hello' } as const
  }
  const clientPublicKey = decodeMobileE2EEPublicKey(hello.publicKeyB64)
  return clientPublicKey
    ? {
        session: null,
        sharedKey: deriveSharedKey(serverSecretKey, clientPublicKey),
        ready: { type: 'e2ee_ready' }
      }
    : ({ error: 'Invalid public key' } as const)
}

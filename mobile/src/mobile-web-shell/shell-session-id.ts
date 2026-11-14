import * as ExpoCrypto from 'expo-crypto'
import { encodeBase64Url } from '../transport/encryption/mobile-session-id-encoding'

// Use 32 random base64url bytes: each mount/remount needs a fresh id for the view’s private origin.
const SESSION_ID_BYTES = 32

export function mintShellSessionId(): string {
  return encodeBase64Url(ExpoCrypto.getRandomBytes(SESSION_ID_BYTES))
}

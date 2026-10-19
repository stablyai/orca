import type { PairedE2EEPrimitives } from '../../../src/shared/paired-e2ee-primitives'
import { derivePairedE2EEV2KeySchedule } from '../../../src/shared/paired-e2ee-v2-key-schedule'
import { decodeBase64Bytes, encodeBase64Bytes } from './base64-byte-codec'
import * as e2ee from './e2ee'

// Why arrows: resolved per call, so transport tests that mock ./e2ee partially still load.
export const MOBILE_PAIRED_E2EE_PRIMITIVES: PairedE2EEPrimitives = {
  generateKeyPair: () => e2ee.generateKeyPair(),
  deriveSharedKey: (ourSecretKey, peerPublicKey) =>
    e2ee.deriveSharedKey(ourSecretKey, peerPublicKey),
  randomBytes: (length) => e2ee.randomBytes(length),
  encodeBase64: encodeBase64Bytes,
  decodeBase64: decodeBase64Bytes,
  publicKeyFromBase64: (value) => e2ee.publicKeyFromBase64(value),
  publicKeyToBase64: (key) => e2ee.publicKeyToBase64(key),
  sealLegacyText: (plaintext, sharedKey) => e2ee.encrypt(plaintext, sharedKey),
  openLegacyText: (frame, sharedKey) => e2ee.decrypt(frame, sharedKey),
  sealLegacyBinary: (plaintext, sharedKey) => e2ee.encryptBytes(plaintext, sharedKey),
  openLegacyBinary: (frame, sharedKey) => e2ee.decryptBytes(frame, sharedKey),
  deriveV2KeySchedule: derivePairedE2EEV2KeySchedule
}

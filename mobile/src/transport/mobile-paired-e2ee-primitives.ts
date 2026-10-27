import nacl from 'tweetnacl'
import type { PairedE2EEPrimitives } from '../../../src/shared/paired-e2ee-primitives'
import { derivePairedE2EEV2KeySchedule } from '../../../src/shared/paired-e2ee-v2-key-schedule'
import {
  decodeBase64Bytes,
  decodeCanonicalBase64Bytes,
  encodeBase64Bytes
} from './base64-byte-codec'
import { pairedE2EENativeCodec } from './paired-e2ee-native-codec'
import * as e2ee from './e2ee'

// Resolve per call so partial e2ee mocks remain loadable in transport tests.
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
  openSecretbox: (box, nonce, key) => {
    const native = pairedE2EENativeCodec()
    return native ? native.openSecretbox(box, nonce, key) : nacl.secretbox.open(box, nonce, key)
  },
  decodeCanonicalBase64: (value) => {
    const native = pairedE2EENativeCodec()
    return native ? native.decodeBase64(value) : decodeCanonicalBase64Bytes(value)
  },
  decodeUtf8: (bytes) =>
    pairedE2EENativeCodec()?.decodeUtf8(bytes) ?? new TextDecoder().decode(bytes),
  deriveV2KeySchedule: derivePairedE2EEV2KeySchedule
}

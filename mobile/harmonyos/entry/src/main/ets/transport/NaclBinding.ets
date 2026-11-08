import { cryptoFramework } from '@kit.CryptoArchitectureKit';
// tweetnacl 1.0.3 vendored from npm (same version as upstream Orca mobile).
// UMD module: resolves to the nacl namespace object under the ArkTS bundler.
import naclModule from '../vendor/nacl-fast.min.js';

/**
 * Typed facade over the vendored tweetnacl UMD bundle. nacl is accessed as ESObject
 * because tweetnacl attaches callable members (secretbox.open, box.keyPair) that
 * ArkTS interfaces cannot express. Only the surface the E2EE v2 codec uses is exposed;
 * NaCl constants below are protocol-fixed (RFC 7748 / tweetnacl source).
 */

export interface NaclBoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

let nacl: ESObject = naclModule as ESObject;

let prngInstalled = false;

function ensurePrng(): void {
  if (prngInstalled) {
    return;
  }
  let rand = cryptoFramework.createRandom();
  // tweetnacl needs a PRNG; HarmonyOS cryptoFramework supplies native secure randomness.
  nacl['setPRNG']((x: Uint8Array, n: number): void => {
    let blob = rand.generateRandomSync(n);
    x.set(blob.data);
  });
  prngInstalled = true;
}

export function naclRandomBytes(n: number): Uint8Array {
  ensurePrng();
  return nacl['randomBytes'](n) as Uint8Array;
}

export function naclGenerateKeyPair(): NaclBoxKeyPair {
  ensurePrng();
  let kp: ESObject = nacl['box']['keyPair']();
  let pair: NaclBoxKeyPair = {
    publicKey: kp['publicKey'] as Uint8Array,
    secretKey: kp['secretKey'] as Uint8Array
  };
  return pair;
}

/** X25519 shared secret followed by HSalsa20, identical to nacl.box.before — what upstream deriveSharedKey calls. */
export function naclBoxBefore(peerPublicKey: Uint8Array, ourSecretKey: Uint8Array): Uint8Array {
  return nacl['box']['before'](peerPublicKey, ourSecretKey) as Uint8Array;
}

export function naclSecretbox(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  ensurePrng();
  return nacl['secretbox'](msg, nonce, key) as Uint8Array;
}

export function naclSecretboxOpen(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null {
  let result: ESObject = nacl['secretbox']['open'](box, nonce, key);
  if (result === null || result === undefined) {
    return null;
  }
  return result as Uint8Array;
}

/** Legacy v1: precomputed nonce encrypt via nacl.box.after (per-message nonce under a shared box key). */
export function naclBoxAfter(msg: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array {
  return nacl['box']['after'](msg, nonce, sharedKey) as Uint8Array;
}

/** Legacy v1: nacl.box.open.after; null when authentication fails. */
export function naclBoxOpenAfter(ciphertext: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array | null {
  let result: ESObject = nacl['box']['open']['after'](ciphertext, nonce, sharedKey);
  if (result === null || result === undefined) {
    return null;
  }
  return result as Uint8Array;
}

// tweetnacl contract constants: secretbox = XSalsa20-Poly1305 with a 24-byte nonce, 32-byte key, 16-byte MAC.
export const SECRETBOX_OVERHEAD_LENGTH: number = 16;
export const SECRETBOX_KEY_LENGTH: number = 32;
export const SECRETBOX_NONCE_LENGTH: number = 24;

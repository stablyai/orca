import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

/**
 * Byte-level helpers shared by the transport stack.
 *
 * Upstream Orca mobile relies on platform TextEncoder/TextDecoder and expo-crypto;
 * on HarmonyOS we map to @ohos.util and cryptoFramework so the wire bytes stay identical.
 */

export function utf8Encode(value: string): Uint8Array {
  // HarmonyOS TextEncoder.encodeInto returns undefined for an empty input; the
  // transcript encoder legitimately encodes empty strings (e.g. relay-host-id on
  // direct connections), so short-circuit to an empty buffer here.
  if (value.length === 0) {
    return new Uint8Array(0);
  }
  let encoder = new util.TextEncoder();
  let encoded = encoder.encodeInto(value);
  if (!encoded) {
    return new Uint8Array(0);
  }
  return encoded;
}

export function utf8Decode(bytes: Uint8Array): string {
  let decoder = util.TextDecoder.create('utf-8');
  return decoder.decodeToString(bytes);
}

export function randomBytes(length: number): Uint8Array {
  let rand = cryptoFramework.createRandom();
  return rand.generateRandomSync(length).data;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    total += parts[i].length;
  }
  let out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i];
  }
  return difference === 0;
}

/** Upstream: uint32 big-endian via DataView. */
export function uint32Bytes(value: number): Uint8Array {
  let bytes = new Uint8Array(4);
  let view = new DataView(bytes.buffer);
  view.setUint32(0, value >>> 0, false);
  return bytes;
}

/** E2EE v2 counter is big-endian, matching upstream writeUint64. */
export function uint64BeBytes(value: number): Uint8Array {
  let bytes = new Uint8Array(8);
  let remaining = Math.floor(value);
  for (let index = 7; index >= 0; index--) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    let n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64_ALPHABET.charAt((n >> 18) & 63);
    out += BASE64_ALPHABET.charAt((n >> 12) & 63);
    out += BASE64_ALPHABET.charAt((n >> 6) & 63);
    out += BASE64_ALPHABET.charAt(n & 63);
  }
  let rest = bytes.length - i;
  if (rest === 1) {
    let n = bytes[i] << 16;
    out += BASE64_ALPHABET.charAt((n >> 18) & 63);
    out += BASE64_ALPHABET.charAt((n >> 12) & 63);
    out += '==';
  } else if (rest === 2) {
    let n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += BASE64_ALPHABET.charAt((n >> 18) & 63);
    out += BASE64_ALPHABET.charAt((n >> 12) & 63);
    out += BASE64_ALPHABET.charAt((n >> 6) & 63);
    out += '=';
  }
  return out;
}

/** Standard padded base64 decode; throws on whitespace, wrong padding or stray bits (canonical like upstream). */
export function base64Decode(value: string): Uint8Array {
  let clean = '';
  for (let i = 0; i < value.length; i++) {
    let ch = value.charAt(i);
    if (ch === '\r' || ch === '\n' || ch === ' ' || ch === '\t') {
      throw new Error('base64 contains whitespace');
    }
    clean += ch;
  }
  if (clean.length % 4 !== 0) {
    throw new Error('base64 length must be a multiple of 4');
  }
  let padding = 0;
  if (clean.endsWith('==')) {
    padding = 2;
  } else if (clean.endsWith('=')) {
    padding = 1;
  }
  let outLength = (clean.length / 4) * 3 - padding;
  let out = new Uint8Array(outLength);
  let buffer = 0;
  let bits = 0;
  let outIndex = 0;
  for (let i = 0; i < clean.length; i++) {
    let ch = clean.charAt(i);
    if (ch === '=') {
      break;
    }
    let v = BASE64_ALPHABET.indexOf(ch);
    if (v < 0) {
      throw new Error('invalid base64 character');
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex++;
    }
  }
  if (padding > 0) {
    let lastSextet = BASE64_ALPHABET.indexOf(clean.charAt(clean.length - padding - 1));
    if (lastSextet < 0) {
      throw new Error('invalid base64 padding character');
    }
    if ((lastSextet & (padding === 2 ? 0x0f : 0x03)) !== 0) {
      throw new Error('non-canonical base64 padding');
    }
  }
  return out;
}

/** Canonicality check + decode in one pass (null for anything non-canonical), mirroring upstream decodeCanonicalBase64Bytes. */
export function base64DecodeCanonical(value: string): Uint8Array | null {
  try {
    let bytes = base64Decode(value);
    if (base64Encode(bytes) !== value) {
      return null;
    }
    return bytes;
  } catch (e) {
    return null;
  }
}

/** base64url (RFC 4648 §5) decode, used for orca://pair?code= payloads. */
export function base64UrlDecode(value: string): Uint8Array {
  let normalized = '';
  for (let i = 0; i < value.length; i++) {
    let ch = value.charAt(i);
    if (ch === '-') {
      normalized += '+';
    } else if (ch === '_') {
      normalized += '/';
    } else if (ch !== '=') {
      normalized += ch;
    }
  }
  let padding = (4 - (normalized.length % 4)) % 4;
  for (let i = 0; i < padding; i++) {
    normalized += '=';
  }
  return base64Decode(normalized);
}

/**
 * Pure-ArkTS SHA-256 / HMAC-SHA256 / HKDF-SHA256 (RFC 6234 / RFC 2104 / RFC 5869).
 *
 * Upstream Orca derives the E2EE v2 key schedule with @noble/hashes; these are the same
 * standard algorithms, vendored as dependency-free ArkTS so the toolchain has no package
 * import to resolve. Byte compatibility is enforced by NIST/RFC test vectors.
 */

const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(input: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  let bitLength = input.length * 8;
  // message = input || 0x80 || zeros || 8-byte big-endian bit length
  let paddedLength = ((input.length + 9 + 63) >>> 6) << 6;
  let message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;
  let view = new DataView(message.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296), false);

  let w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(block + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      let s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      let s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let t = 0; t < 64; t++) {
      let S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      let ch = (e & f) ^ (~e & g);
      let t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      let S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      let maj = (a & b) ^ (a & c) ^ (b & c);
      let t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }
  let out = new Uint8Array(32);
  let outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  let block = 64;
  let keyBytes = key.length > block ? sha256(key) : key;
  let ipad = new Uint8Array(block);
  let opad = new Uint8Array(block);
  for (let i = 0; i < block; i++) {
    let b = i < keyBytes.length ? keyBytes[i] : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  let inner = new Uint8Array(block + data.length);
  inner.set(ipad);
  inner.set(data, block);
  let innerHash = sha256(inner);
  let outer = new Uint8Array(block + 32);
  outer.set(opad);
  outer.set(innerHash, block);
  return sha256(outer);
}

/**
 * HKDF-SHA256 in one step (RFC 5869), mirroring @noble/hashes hkdf(sha256, ikm, salt, info, length).
 */
export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  let prk = hmacSha256(salt.length > 0 ? salt : new Uint8Array(32), ikm);
  let blocks = Math.ceil(length / 32);
  let out = new Uint8Array(blocks * 32);
  let previous = new Uint8Array(0);
  for (let i = 0; i < blocks; i++) {
    let blockInput = new Uint8Array(previous.length + info.length + 1);
    blockInput.set(previous, 0);
    blockInput.set(info, previous.length);
    blockInput[blockInput.length - 1] = i + 1;
    previous = hmacSha256(prk, blockInput);
    out.set(previous, i * 32);
  }
  return out.slice(0, length);
}

// Kept as a compatible command; vectors now execute the actual ArkTS implementation.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadArkts } = require('./arkts-source.cjs')
const { sha256, hmacSha256, hkdfSha256 } = loadArkts('transport/crypto/Sha256.ets', [
  'sha256',
  'hmacSha256',
  'hkdfSha256'
])
const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'))
const text = (value) => new TextEncoder().encode(value)
const cases = [
  [
    'SHA256 empty',
    () => sha256(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ],
  [
    'SHA256 abc',
    () => sha256(text('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  ],
  [
    'RFC 4231 HMAC case 1',
    () => hmacSha256(new Uint8Array(20).fill(0x0b), text('Hi There')),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  ],
  [
    'RFC 4231 HMAC case 2',
    () => hmacSha256(text('Jefe'), text('what do ya want for nothing?')),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  ],
  [
    'RFC 5869 HKDF case 1',
    () =>
      hkdfSha256(
        new Uint8Array(22).fill(0x0b),
        hex('000102030405060708090a0b0c'),
        hex('f0f1f2f3f4f5f6f7f8f9'),
        42
      ),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
  ],
  [
    'RFC 5869 HKDF case 3',
    () => hkdfSha256(new Uint8Array(22).fill(0x0b), new Uint8Array(), new Uint8Array(), 42),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'
  ]
]
for (const [name, calculate, expected] of cases) {
  assert.equal(Buffer.from(calculate()).toString('hex'), expected, name)
  console.log(`PASS ${String(name)}`)
}
console.log(`${cases.length} vectors passed against Sha256.ets`)

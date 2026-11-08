const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomBytes } = require('node:crypto')
const naclModule = require('../vendor/tweetnacl/nacl-fast.min.js')
const fixture = require('./fixtures/e2ee-v2-vectors.json')
const { loadArkts, util } = require('./arkts-source.cjs')

const bytes = loadArkts(
  'transport/crypto/Bytes.ets',
  [
    'uint32Bytes',
    'uint64BeBytes',
    'utf8Encode',
    'utf8Decode',
    'concatBytes',
    'equalBytes',
    'base64Encode',
    'base64Decode',
    'base64DecodeCanonical',
    'base64UrlDecode'
  ],
  { util }
)
const hashes = loadArkts('transport/crypto/Sha256.ets', ['sha256', 'hkdfSha256'], bytes)
const nacl = loadArkts(
  'transport/NaclBinding.ets',
  [
    'naclBoxBefore',
    'naclSecretbox',
    'naclSecretboxOpen',
    'SECRETBOX_OVERHEAD_LENGTH',
    'SECRETBOX_KEY_LENGTH',
    'SECRETBOX_NONCE_LENGTH'
  ],
  {
    naclModule,
    cryptoFramework: {
      createRandom: () => ({
        generateRandomSync: (length) => ({ data: new Uint8Array(randomBytes(length)) })
      })
    }
  }
)
function session(vector) {
  const { E2eeV2ClientSession, buildV2TokenAuthJson } = loadArkts(
    'transport/E2eeV2Session.ets',
    ['E2eeV2ClientSession', 'buildV2TokenAuthJson'],
    {
      ...bytes,
      ...hashes,
      ...nacl,
      naclGenerateKeyPair: () => ({
        publicKey: new Uint8Array(Buffer.from(fixture.clientPublicKeyB64, 'base64')),
        secretKey: new Uint8Array(Buffer.from(fixture.clientSecretHex, 'hex'))
      }),
      naclRandomBytes: () => new Uint8Array(Buffer.from(fixture.clientNonceB64, 'base64'))
    }
  )
  const channel = new E2eeV2ClientSession(vector.transport, vector.hello.context.relayHostId ?? '')
  channel.setPinnedKey(vector.ready.desktopPublicKeyB64)
  return { channel, buildV2TokenAuthJson }
}
for (const vector of fixture.vectors) {
  test(`actual ArkTS ${vector.transport} E2EE matches upstream auth, binary and receive vectors`, () => {
    const { channel, buildV2TokenAuthJson } = session(vector)
    assert.deepEqual(JSON.parse(channel.helloJson), vector.hello)
    assert.equal(channel.acceptReady(vector.ready), true)
    assert.equal(channel.transcriptHashB64, vector.transcriptHashB64)
    assert.equal(
      channel.sealText(buildV2TokenAuthJson(channel.transcriptHashB64, 'vector-device-token')),
      vector.sealedAuthB64
    )
    assert.equal(
      Buffer.from(channel.sealBinary(Buffer.from(vector.binaryHex, 'hex'))).toString('base64'),
      vector.sealedBinaryB64
    )
    assert.equal(channel.openText(vector.serverTextB64), vector.serverText)
    assert.equal(
      Buffer.from(channel.openBinary(Buffer.from(vector.serverBinaryB64, 'base64'))).toString(
        'hex'
      ),
      vector.binaryHex
    )
    assert.equal(channel.openText(vector.serverTextB64), null)
  })
}
test('a relay ready bound to another host cannot authenticate the pinned channel', () => {
  const vector = fixture.vectors[1]
  const { channel } = session(vector)
  const ready = {
    ...vector.ready,
    context: { ...vector.ready.context, relayHostId: 'AnotherRelayHost' }
  }
  assert.equal(channel.acceptReady(ready), false)
})

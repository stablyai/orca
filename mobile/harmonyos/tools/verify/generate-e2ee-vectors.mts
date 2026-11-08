import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Regenerate only against the documented upstream base, never while running the regression.
const upstream = resolve(process.argv[2])
const require = createRequire(join(upstream, 'package.json'))
const nacl = require('tweetnacl')
const source = 'src/shared/remote-runtime/e2ee'
const load = (name: string) => import(pathToFileURL(join(upstream, source, name)).href)
const { PairedE2EEV2ClientSession } = await load('paired-e2ee-v2-client-session.ts')
const { NODE_PAIRED_E2EE_PRIMITIVES } = await load('node/paired-e2ee-node-primitives.ts')
const { validateMobileE2EEV2Handshake, encodeMobileE2EEV2Transcript } = await load(
  'mobile-e2ee-v2-contract.ts'
)
const { deriveMobileE2EEV2KeySchedule } = await load('node/mobile-e2ee-v2-node-key-schedule.ts')
const { sealMobileE2EEV2Frame } = await load('mobile-e2ee-v2-framing.ts')
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64')
const clientSecret = Uint8Array.from({ length: 32 }, (_, at) => at + 1)
const desktopSecret = Uint8Array.from({ length: 32 }, (_, at) => at + 65)
const clientKeys = nacl.box.keyPair.fromSecretKey(clientSecret)
const desktopKeys = nacl.box.keyPair.fromSecretKey(desktopSecret)
const clientNonce = Uint8Array.from({ length: 32 }, (_, at) => at + 101)
const desktopNonce = Uint8Array.from({ length: 32 }, (_, at) => at + 151)
const vectors = []
for (const transport of ['direct', 'relay']) {
  const session = PairedE2EEV2ClientSession.create({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    desktopPublicKeyB64: b64(desktopKeys.publicKey),
    transport,
    ...(transport === 'relay' ? { relayHostId: 'AbCdEf0123_-xyZ9' } : {}),
    clientNonce,
    clientKeyPair: clientKeys
  })
  const ready = {
    type: 'e2ee_ready',
    v: 2,
    desktopPublicKeyB64: b64(desktopKeys.publicKey),
    clientNonceB64: b64(clientNonce),
    desktopNonceB64: b64(desktopNonce),
    selection: { framing: 2, payloadKinds: ['text', 'binary'] },
    context: session.hello.context
  }
  if (!session.acceptReady(ready)) {
    throw new Error('Upstream refused its synthetic fixture')
  }
  const handshake = validateMobileE2EEV2Handshake(session.hello, ready)
  const schedule = deriveMobileE2EEV2KeySchedule({
    sharedSecret: nacl.box.before(clientKeys.publicKey, desktopKeys.secretKey),
    transcript: encodeMobileE2EEV2Transcript(handshake),
    clientNonce,
    desktopNonce
  })
  const auth = {
    type: 'e2ee_auth',
    v: 2,
    transcriptHashB64: session.transcriptHashB64,
    deviceToken: 'vector-device-token'
  }
  const serverText = '{"id":"fixture-rpc","ok":true,"result":{"name":"桌面"}}'
  const binary = Uint8Array.from([0x74, 1, 0, 255, 17, 0, 1])
  const serverFrame = (payload: Uint8Array, kind: string, counter: bigint) =>
    sealMobileE2EEV2Frame({
      payload,
      key: schedule.desktopToMobileKey,
      sessionId: schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: kind,
      counter
    })
  vectors.push({
    transport,
    hello: session.hello,
    ready,
    transcriptHashB64: session.transcriptHashB64,
    auth,
    sealedAuthB64: session.sealText(JSON.stringify(auth)),
    sealedBinaryB64: b64(session.sealBinary(binary)),
    serverText,
    serverTextB64: b64(serverFrame(new TextEncoder().encode(serverText), 'text', 0n)),
    serverBinaryB64: b64(serverFrame(binary, 'binary', 1n)),
    binaryHex: Buffer.from(binary).toString('hex')
  })
}
const result = {
  source: 'stablyai/orca',
  base: '10c01509de6769f5a8baef080c993d77ac493127',
  sources: [
    'paired-e2ee-v2-client-session.ts',
    'mobile-e2ee-v2-contract.ts',
    'mobile-e2ee-v2-framing.ts',
    'node/mobile-e2ee-v2-node-key-schedule.ts'
  ],
  clientSecretHex: Buffer.from(clientSecret).toString('hex'),
  clientPublicKeyB64: b64(clientKeys.publicKey),
  clientNonceB64: b64(clientNonce),
  vectors
}
writeFileSync(
  join(import.meta.dirname, 'fixtures/e2ee-v2-vectors.json'),
  `${JSON.stringify(result, null, 2)}\n`
)

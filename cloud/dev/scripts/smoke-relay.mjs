import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const requireFromRelay = createRequire(new URL('../../apps/relay/package.json', import.meta.url))

const relayUrl = process.argv[2]?.replace(/\/$/, '')
if (!relayUrl) throw new Error('usage: smoke-relay.mjs <relay-origin>')

const health = await fetch(`${relayUrl}/health`)
if (!health.ok || (await health.json()).ok !== true) {
  throw new Error(`relay health failed: ${health.status}`)
}

const accessToken = process.env.ORCA_RELAY_SMOKE_ACCESS_TOKEN
const authUrl = process.env.ORCA_RELAY_SMOKE_AUTH_URL?.replace(/\/$/, '')
const signingKeyFile = process.env.ORCA_RELAY_SMOKE_SIGNING_KEY_FILE
if (!authUrl || (!accessToken && !signingKeyFile)) {
  console.log('relay health smoke passed; provide auth URL plus an access token or operator signing-key file for a splice round-trip')
  process.exit(0)
}

const nacl = requireFromRelay('tweetnacl')
const WebSocket = requireFromRelay('ws')
const { buildHostProofMacInput, HOST_CHALLENGE_PLAINTEXT_DOMAIN } = await import(
  requireFromRelay.resolve('@orca-cloud/relay-contract')
)

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      cleanup()
      try {
        resolve(JSON.parse(data.toString()))
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(new Error(`socket closed before message: ${code} ${reason.toString()}`))
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.once('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

const hostKeys = nacl.box.keyPair()
const relayHostId = createHash('sha256')
  .update(hostKeys.publicKey)
  .digest('base64url')
  .slice(0, 16)
let relayToken
if (accessToken) {
  const tokenResponse = await fetch(`${authUrl}/v1/desktop/auth/relay-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      relayHostId,
      hostPublicKeyB64: Buffer.from(hostKeys.publicKey).toString('base64')
    })
  })
  if (!tokenResponse.ok) throw new Error(`relay-token exchange failed: ${tokenResponse.status}`)
  ;({ relayToken } = await tokenResponse.json())
} else {
  // This operator-only path proves the deployed data plane before desktop UI
  // exists; possession of the auth signing key remains the security boundary.
  const { SignJWT } = await import(requireFromRelay.resolve('jose'))
  const privateKey = createPrivateKey(readFileSync(signingKeyFile, 'utf8'))
  const keyId = createHash('sha256')
    .update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }))
    .digest('base64url')
    .slice(0, 16)
  relayToken = await new SignJWT({
    prof: 'staging-smoke-profile',
    org: 'staging-smoke-org',
    purpose: 'host-control',
    relayHostId
  })
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(authUrl)
    .setAudience('orca-relay')
    .setSubject('staging-smoke-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}
if (!relayToken) throw new Error('relay token was not produced')

const wsOrigin = relayUrl.replace(/^http/, 'ws')
const control = new WebSocket(`${wsOrigin}/v1/host/control`, {
  headers: { authorization: `Bearer ${relayToken}` },
  perMessageDeflate: false
})
await opened(control)
control.send(
  JSON.stringify({
    type: 'host-hello',
    v: 1,
    relayHostId,
    assignmentEpoch: 1,
    hostPublicKeyB64: Buffer.from(hostKeys.publicKey).toString('base64'),
    appVersion: 'relay-smoke'
  })
)
const challenge = await nextMessage(control)
const plaintext = nacl.box.open(
  Buffer.from(challenge.ciphertextB64, 'base64'),
  Buffer.from(challenge.nonceB64, 'base64'),
  Buffer.from(challenge.relayEphemeralPublicKeyB64, 'base64'),
  hostKeys.secretKey
)
if (!plaintext) throw new Error('host proof challenge did not decrypt')
const domain = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
const transcriptLength = new DataView(
  plaintext.buffer,
  plaintext.byteOffset + domain.length,
  4
).getUint32(0, false)
const transcriptStart = domain.length + 4
const transcript = plaintext.slice(transcriptStart, transcriptStart + transcriptLength)
const secret = plaintext.slice(transcriptStart + transcriptLength)
const proofB64 = createHmac('sha256', secret)
  .update(buildHostProofMacInput(transcript))
  .digest('base64')
control.send(JSON.stringify({
  type: 'host-challenge-ack',
  challengeId: challenge.challengeId,
  proofB64
}))
const hostAck = await nextMessage(control)

const relayDeviceId = `smoke-${randomUUID()}`
const invitePromise = nextMessage(control)
control.send(JSON.stringify({ type: 'invite-create', reqId: randomUUID(), relayDeviceId }))
const invite = await invitePromise

const phone = new WebSocket(`${wsOrigin}/v1/connect/${relayHostId}`, { perMessageDeflate: false })
await opened(phone)
const connectionPromise = nextMessage(control)
phone.send(JSON.stringify({
  type: 'relay-auth',
  v: 1,
  mode: 'connect',
  credential: invite.inviteToken
}))
const connection = await connectionPromise
const data = new WebSocket(`${wsOrigin}/v1/host/data/${connection.connId}`, {
  perMessageDeflate: false
})
await opened(data)
const phoneHelloPromise = nextMessage(phone)
data.send(JSON.stringify({
  type: 'host-data-auth',
  v: 1,
  connTicket: connection.connTicket,
  generation: hostAck.generation
}))
const phoneHello = await phoneHelloPromise
if (phoneHello.ok !== true) throw new Error('relay rejected smoke splice')

const phoneEcho = new Promise((resolve, reject) => {
  phone.once('message', (bytes, binary) => resolve({ bytes: Buffer.from(bytes), binary }))
  phone.once('error', reject)
})
data.send(Buffer.from([0x4f, 0x52, 0x43, 0x41]))
const echoed = await phoneEcho
if (!echoed.binary || !echoed.bytes.equals(Buffer.from([0x4f, 0x52, 0x43, 0x41]))) {
  throw new Error('relay splice changed binary payload or opcode')
}

const dataEcho = new Promise((resolve, reject) => {
  data.once('message', (bytes, binary) => resolve({ bytes: Buffer.from(bytes), binary }))
  data.once('error', reject)
})
phone.send('orca-relay-smoke')
const returned = await dataEcho
if (returned.binary || returned.bytes.toString() !== 'orca-relay-smoke') {
  throw new Error('relay splice changed text payload or opcode')
}

phone.close()
data.close()
control.close()
console.log('relay authenticated splice smoke passed')

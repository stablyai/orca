#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const expectedNodeMajor = process.env.ORCA_FIRST_PARTY_TRUST_SMOKE_NODE_MAJOR ?? '18'
assert.match(expectedNodeMajor, /^\d+$/, 'Expected a numeric Node major')
assert.equal(
  process.versions.node.split('.')[0],
  expectedNodeMajor,
  `This smoke test must run under Node ${expectedNodeMajor}`
)

const require = createRequire(import.meta.url)
const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'orca-first-party-node18-'))
const rootKey = join(fixtureDirectory, 'root.key')
const rootCertificate = join(fixtureDirectory, 'root.pem')
const serverKey = join(fixtureDirectory, 'server.key')
const serverRequest = join(fixtureDirectory, 'server.csr')
const serverCertificate = join(fixtureDirectory, 'server.pem')
const serverExtensions = join(fixtureDirectory, 'server.ext')

function openssl(args) {
  execFileSync('openssl', args, { stdio: 'ignore' })
}

function bounded(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function nextSocketMessage(socket, label) {
  return bounded(
    new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(data.toString()))
      socket.once('error', reject)
    }),
    label
  )
}

function socketError(socket, label) {
  return bounded(
    new Promise((resolve, reject) => {
      socket.once('error', resolve)
      socket.once('open', () => {
        socket.terminate()
        reject(new Error(`${label} unexpectedly opened`))
      })
    }),
    label
  )
}

function assertTlsErrorCode(expectedCode) {
  return (error) => {
    assert.equal(error?.cause?.code ?? error?.code, expectedCode)
    return true
  }
}

function readRequestBody(request) {
  return bounded(
    new Promise((resolve, reject) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.once('error', reject)
    }),
    `HTTP body ${request.url}`
  )
}

function connectionPromise() {
  let resolve
  const promise = new Promise((accepted) => {
    resolve = accepted
  })
  return { promise, resolve }
}

let server
let wss
let controlClient
let mismatchedControlClient
let dataTransport
try {
  await writeFile(
    serverExtensions,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n'
  )
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    rootKey,
    '-out',
    rootCertificate,
    '-subj',
    '/CN=Orca Node 18 Test Root',
    '-days',
    '1',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign'
  ])
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    serverKey,
    '-out',
    serverRequest,
    '-subj',
    '/CN=fixture.invalid'
  ])
  openssl([
    'x509',
    '-req',
    '-in',
    serverRequest,
    '-CA',
    rootCertificate,
    '-CAkey',
    rootKey,
    '-CAcreateserial',
    '-out',
    serverCertificate,
    '-days',
    '1',
    '-extfile',
    serverExtensions
  ])

  // Inject the fixture through Node's explicit CA input to isolate transport behavior;
  // platform trust-store enumeration is covered by the unit matrix.
  process.env.NODE_EXTRA_CA_CERTS = rootCertificate
  const transport = require(join(projectDir, 'out/test/first-party-node18-trust-smoke.cjs'))
  const cloudRequests = []
  const relayRequests = []
  server = createServer(
    { key: await readFile(serverKey), cert: await readFile(serverCertificate) },
    async (request, response) => {
      try {
        const body = await readRequestBody(request)
        if (request.url === '/session') {
          cloudRequests.push({
            method: request.method,
            contentType: request.headers['content-type'],
            authorization: request.headers.authorization,
            body
          })
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({
              accessToken: 'fixture-access-token',
              refreshToken: 'fixture-refresh-token',
              expiresAt: Date.now() + 60_000,
              cloud: {
                cloudProfileId: 'cloud-profile-1',
                userId: 'user-1',
                email: 'fixture@example.com',
                linkedAt: Date.now()
              },
              organizations: [],
              capabilities: { flags: { relay: true }, refreshedAt: Date.now() }
            })
          )
          return
        }
        if (request.url === '/relay-token' || request.url === '/v1/assign') {
          relayRequests.push({
            url: request.url,
            method: request.method,
            contentType: request.headers['content-type'],
            authorization: request.headers.authorization,
            body
          })
          response.setHeader('content-type', 'application/json')
          response.end(
            request.url === '/relay-token'
              ? JSON.stringify({
                  relayToken: 'fixture-relay-token',
                  expiresAt: Date.now() + 60_000
                })
              : JSON.stringify({
                  v: 1,
                  cellUrl: httpsUrl,
                  assignmentEpoch: 3,
                  lease: 'fixture-lease'
                })
          )
          return
        }
        response.writeHead(404).end()
      } catch (error) {
        response.destroy(error)
      }
    }
  )
  wss = new WebSocketServer({ server, perMessageDeflate: false })
  const controlConnection = connectionPromise()
  const dataConnection = connectionPromise()
  wss.on('connection', (socket, request) => {
    const accepted = { socket, request }
    if (request.url === '/v1/host/control') {
      controlConnection.resolve(accepted)
    } else {
      dataConnection.resolve(accepted)
    }
  })
  await new Promise((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const httpsUrl = `https://127.0.0.1:${address.port}`

  await assert.rejects(
    globalThis.fetch(httpsUrl),
    assertTlsErrorCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  )
  const rawWssError = await socketError(
    new WebSocket(`wss://127.0.0.1:${address.port}`),
    'raw Node WSS rejection'
  )
  assert.equal(rawWssError.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  const session = await transport.exchangeOrcaCloudAuthCode(
    { sessionEndpoint: `${httpsUrl}/session` },
    {
      code: 'fixture-code',
      codeVerifier: 'fixture-verifier',
      nonce: 'fixture-nonce',
      redirectUri: 'orca://auth/callback',
      state: 'fixture-state',
      localProfileId: 'local-profile-1'
    }
  )
  assert.equal(session.accessToken, 'fixture-access-token')
  assert.deepEqual(cloudRequests, [
    {
      method: 'POST',
      contentType: 'application/json',
      authorization: undefined,
      body: JSON.stringify({
        code: 'fixture-code',
        codeVerifier: 'fixture-verifier',
        nonce: 'fixture-nonce',
        redirectUri: 'orca://auth/callback',
        state: 'fixture-state',
        localProfileId: 'local-profile-1'
      })
    }
  ])

  const nacl = require('tweetnacl')
  const hostKeys = nacl.box.keyPair()
  const keypair = {
    ...hostKeys,
    publicKeyB64: Buffer.from(hostKeys.publicKey).toString('base64')
  }
  const relayHostId = createHash('sha256')
    .update(hostKeys.publicKey)
    .digest('base64url')
    .slice(0, 16)
  const authorization = await transport.exchangeRelayAuthorization({
    endpoint: `${httpsUrl}/relay-token`,
    accessToken: session.accessToken,
    keypair
  })
  const assignment = await transport.requestRelayAssignment({
    directorUrl: httpsUrl,
    relayToken: authorization.relayToken,
    relayHostId
  })
  assert.equal(assignment.cellUrl, httpsUrl)
  assert.deepEqual(
    relayRequests.map(({ url, method, contentType, authorization }) => ({
      url,
      method,
      contentType,
      authorization
    })),
    [
      {
        url: '/relay-token',
        method: 'POST',
        contentType: 'application/json',
        authorization: 'Bearer fixture-access-token'
      },
      {
        url: '/v1/assign',
        method: 'POST',
        contentType: 'application/json',
        authorization: 'Bearer fixture-relay-token'
      }
    ]
  )
  assert.deepEqual(JSON.parse(relayRequests[0].body), {
    relayHostId,
    hostPublicKeyB64: keypair.publicKeyB64
  })
  assert.deepEqual(JSON.parse(relayRequests[1].body), { v: 1, relayHostId })

  controlClient = new transport.RelayControlClient({
    cellUrl: httpsUrl,
    relayJwt: authorization.relayToken,
    relayHostId,
    assignmentEpoch: assignment.assignmentEpoch,
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair,
    appVersion: 'node18-smoke',
    onConnectionOpen: () => {},
    onDrain: () => {},
    onClose: () => {}
  })
  const connecting = assert.rejects(controlClient.connect(), /relay_control_closed/)
  const acceptedControl = await bounded(controlConnection.promise, 'Relay control connection')
  assert.equal(acceptedControl.request.headers.authorization, 'Bearer fixture-relay-token')
  const hostHello = JSON.parse(await nextSocketMessage(acceptedControl.socket, 'Relay host hello'))
  assert.deepEqual(hostHello, {
    type: 'host-hello',
    v: 1,
    relayHostId,
    assignmentEpoch: 3,
    hostPublicKeyB64: keypair.publicKeyB64,
    appVersion: 'node18-smoke'
  })
  controlClient.closeNow()
  await connecting

  let receivedData
  dataTransport = new transport.CloudRelayTransport({
    cellUrl: httpsUrl,
    relayHostId,
    generation: 7
  })
  dataTransport.onMessage((message, respond) => {
    receivedData = message
    respond('node18-data-reply')
  })
  await dataTransport.start()
  const openingData = dataTransport.openConnection({
    connId: 'fixture-connection',
    connTicket: 'fixture-ticket',
    kind: 'resume',
    relayDeviceId: 'fixture-device',
    attachDeadlineMs: 5_000
  })
  const acceptedData = await bounded(dataConnection.promise, 'Relay data connection')
  assert.equal(acceptedData.request.url, '/v1/host/data/fixture-connection')
  assert.deepEqual(
    JSON.parse(await nextSocketMessage(acceptedData.socket, 'Relay data authorization')),
    {
      type: 'host-data-auth',
      v: 1,
      connTicket: 'fixture-ticket',
      generation: 7
    }
  )
  await openingData
  acceptedData.socket.send('node18-data-message')
  assert.equal(
    await nextSocketMessage(acceptedData.socket, 'Relay data reply'),
    'node18-data-reply'
  )
  assert.equal(receivedData, 'node18-data-message')

  const mismatchedUrl = httpsUrl.replace('127.0.0.1', 'localhost')
  await assert.rejects(
    transport.exchangeOrcaCloudAuthCode(
      { sessionEndpoint: `${mismatchedUrl}/session` },
      {
        code: 'fixture-code',
        codeVerifier: 'fixture-verifier',
        nonce: 'fixture-nonce',
        redirectUri: 'orca://auth/callback',
        state: 'fixture-state',
        localProfileId: 'local-profile-1'
      }
    ),
    assertTlsErrorCode('ERR_TLS_CERT_ALTNAME_INVALID')
  )
  mismatchedControlClient = new transport.RelayControlClient({
    cellUrl: mismatchedUrl,
    relayJwt: authorization.relayToken,
    relayHostId,
    assignmentEpoch: assignment.assignmentEpoch,
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair,
    appVersion: 'node18-smoke',
    onConnectionOpen: () => {},
    onDrain: () => {},
    onClose: () => {}
  })
  await assert.rejects(
    mismatchedControlClient.connect(),
    assertTlsErrorCode('ERR_TLS_CERT_ALTNAME_INVALID')
  )
} finally {
  controlClient?.closeNow()
  mismatchedControlClient?.closeNow()
  await dataTransport?.stop()
  for (const client of wss?.clients ?? []) {
    client.terminate()
  }
  if (wss) {
    await new Promise((resolve) => wss.close(resolve))
  }
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  await rm(fixtureDirectory, { recursive: true, force: true })
}

console.log(`Node ${expectedNodeMajor} first-party HTTPS and WSS trust smoke passed.`)

import { createServer } from 'node:https'
import type * as NodeTls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocket, { WebSocketServer } from 'ws'

const tlsFixture = vi.hoisted(() => ({
  root: `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIBATANBgkqhkiG9w0BAQsFADAdMRswGQYDVQQDDBJPcmNh
IFRMUyBUZXN0IFJvb3QwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEwMDAwMDBa
MB0xGzAZBgNVBAMMEk9yY2EgVExTIFRlc3QgUm9vdDCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAKquoph4TAxs9pGPtKsq5hRmAY6TuiBBs2WJcbbTcVS+
EU6i0uHWvAEmzMhIWRJ9OrrbposDNC0/etu8TofiLseR4KOKdkX+mJi36zXgEbJh
me5ZJM0tYiLcNU09t4/bMiWqp07zngBWlIggWX+7y39Nk+tHKfKQIeLmxQAY00V7
eASMlttdtp3SPRI50Z79Y5AemYqhCPR2+TP0utzMucmoJn5Luc9T6rK5Dy2y+1rc
4fnsB9s2IsXygvRlgihGt9HKSCWdwMZSAzjnXbhs9fbidT5V+3HU8EsmELKwxUkE
y4qpg/UNo2G9nY83muv95ysolzPx02oW3jvf2wR5clcCAwEAAaNjMGEwDwYDVR0T
AQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFKyxMJwYL8ILhCs0
R+GtDO5u+2STMB8GA1UdIwQYMBaAFKyxMJwYL8ILhCs0R+GtDO5u+2STMA0GCSqG
SIb3DQEBCwUAA4IBAQA+EawROjxEa/0conkBdcENpG4IYWVQnVFcTu2zEUbvbpHM
/5FVbO1qAfDhUV/G0733dGPDBJFHA3s6Arx2D5UefnhKecHF3yCNixIyfSYdvYHT
QZpYxL6eVnS4+4kPlN8qXaLqn8+tbKVDAynQ5gqOSl0xaee5bnUEVdgPHNnl6V01
3bX7A+BQRyWRQrKdJV5J2dduutQIy9S06tSp0lAbF5630oOTSjSERySsufoS1x1S
Z9fYs4bGZwg6Orv6j+ZL6L/dCuFrGUSKfJL+mOlEmQQQ/Bi1YxgiPFzEn79zbh6P
V3TkA1/Dh2qxDZ7J68cUOt5CHHeJLoTRr1ljTBjr
-----END CERTIFICATE-----`,
  certificate: `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIBAjANBgkqhkiG9w0BAQsFADAdMRswGQYDVQQDDBJPcmNh
IFRMUyBUZXN0IFJvb3QwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEwMDAwMDBa
MBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAOdsf8hPOTmsrXOGw/281fP9/92XMRrd96Qyhc+TUA1nkC8Bh2O+DCV1
VR4S+f8XtPKQCCfyn/lslOES2qf9Q72wyu9Np3qWu68rj6m8XHstWumgXusRx2HL
SF1q92KZRRaWtwJ72CSF9qbFi4eCeIHS5o9S6JweaPFFdKrey91O+uIZoJRXjmkx
jpB7ezYcLm8JM6oIE6gHXnS8lPRYUAB5+TwYCVPl5aUzYqhzoSfW2FtECOQ5P/oo
G60OKHKp2aS/Fhzv29g3+I8ft6+asb3G+RJE6Au2aiyAJqpxA/5WX3l7KOA42QnR
MdIFWHzaWBgtvUJ9B2hwtfDL0CBRVLcCAwEAAaOBkjCBjzAMBgNVHRMBAf8EAjAA
MA4GA1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATAaBgNVHREEEzAR
gglsb2NhbGhvc3SHBH8AAAEwHQYDVR0OBBYEFLnHwsUs4hRgJhzn7IUrA1i/sPV9
MB8GA1UdIwQYMBaAFKyxMJwYL8ILhCs0R+GtDO5u+2STMA0GCSqGSIb3DQEBCwUA
A4IBAQCfsuPuMP1WEsufAMaJ3wf1ArxOjDT7xvltv30VQ42w0QKf/rpqLeNTfURL
V5kwYzXhMPOPOtYTHgSg1kDIRMz8AJtWBQJmgEdrPEzLQx/nS/EpXHY3LtHr2KuL
0IrEYKxWLWQU4es1hcUjJoNR3oEVgVSB0AueHvjd4/VLtdNS3JZBFHqw//1cTsLS
m+WZwH1SzND+WHp1ERjggzqG/dO9ShZtrGXlMVSNzN/XjCDgHjyzy0s6GZrjzhmD
h8iSy7Bca9X8ewOaVMlUOTMuMNn+d2lqsM9PXCO8VTf2NY6eYfnFh8/HaySVG5n8
FSQ1f4hAbEOSmOOKuM/FgmvY/+os
-----END CERTIFICATE-----`,
  key: `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA52x/yE85Oaytc4bD/bzV8/3/3ZcxGt33pDKFz5NQDWeQLwGH
Y74MJXVVHhL5/xe08pAIJ/Kf+WyU4RLap/1DvbDK702nepa7ryuPqbxcey1a6aBe
6xHHYctIXWr3YplFFpa3AnvYJIX2psWLh4J4gdLmj1LonB5o8UV0qt7L3U764hmg
lFeOaTGOkHt7NhwubwkzqggTqAdedLyU9FhQAHn5PBgJU+XlpTNiqHOhJ9bYW0QI
5Dk/+igbrQ4ocqnZpL8WHO/b2Df4jx+3r5qxvcb5EkToC7ZqLIAmqnED/lZfeXso
4DjZCdEx0gVYfNpYGC29Qn0HaHC18MvQIFFUtwIDAQABAoIBAEh/RlaHbvtg22N2
A97wsavCVc3ip8jtYT9Ibn/U+75/Q31eQr4d0qtHYvdNZZCiqhZUxaFSEghumgMa
R3JZ1kdN43zs/DrcjoY1JMe9ENGrpy/KBAIq6yV5K73MHRx/vFNzungmONNUPi0H
dIrqdfrhiUW76M/DfQecRQykSAQXOeOSZ6EtD/Z2CMpjzgHp4dDsMfO+XWkcbgQL
4WV5p+JmPoEp+9YljzEymWI64J5zDubBWwKHOaxRFQbVdDZIXUeNS6y9M+ALKcWC
GWyKGw5K4c2bvf2Od5mVrCQisXICepr3P9SXOxUOs4NMRJNZ9UUJEJGgiHioq43h
GZ1FEiECgYEA85S33fnO0tMK+4J1rj81eFe+WnMytmW7d3Yxh/Fmck7MHvCkubGK
Tq/Fu+BVDiEyGKegSFvtVxBrg8MvAcAb6vTKk3CIef5zWXW7K04mtXjyLlshd89Q
+6wd9t6ozoIQoxCWgjYR4j7jdfmdud+XsCzfmWp5FnJeX54JLOcaYuECgYEA8zka
a8qs7eS4L+5v1Y8tVyvV2EYF9hazIjk7Itc6GIxZzg6rURQ6cTLXjUWRv5sOfwap
uLcz8phKY7SyYTZ1n28NPYmI/EXmo9ERBIbEVgrjKu87Fcruyn4l7Rzj8IWOhH+Q
Z7Jpjc3hXQd10UG18Fv/iFTE3UN90DJ4IK2jQpcCgYAxiyRC4BazRv3K3mQ1RuIH
UkGDgD7mXpbc24uDjRQ7V8+o02WN55CsJJBhgGWMdDAOV7oAPcJunQZhTIf5ISwM
hDHX/2Gi/qBTp+CkFEdHTgxkZWDPT7m3FvEZT3yiVE4x/KPAZGMK06PMUTNFpTbj
PJ1WRRPP/v83D5vqKC9zwQKBgQDqB8QYfAgxT6a62B7byszB1/gIBjiuNeFfyNnS
CG5qOIIg95R4i5JAYb9uu8YmK7ijGXItvnpJr6fEkJYjXBeJtX1z/ObGdywZ7I0H
YfWBJTC4m0CrE3z5crBjmyzovloHvAbjAJT4UWXL8eW32BaMlLkoIQjcLpjcv/M+
3lT9OQKBgQClL+w7o1tX0k4mTbtIheTOkv8j23ihSzi8nJsXGzplE4CWgipv3Vwd
MXNQ/3oK8d74MChZLcanPzKzRrMQ6qKwihfZ/XslLx+TGSCbpURm2TTkqiX0gQmp
xYkHRuf4DaYYhyukIwBP5hTw3jJQFXOFD8NQ+n1ij/RtBBA3T0qqxA==
-----END RSA PRIVATE KEY-----`
}))

vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<typeof NodeTls>()
  return {
    ...original,
    getCACertificates: (type: Parameters<typeof original.getCACertificates>[0]) =>
      type === 'system' ? [tlsFixture.root] : original.getCACertificates(type)
  }
})

import {
  createFirstPartyRelayControlWebSocket,
  createFirstPartyRelayDataWebSocket,
  prepareFirstPartyRelayWebSocketTrust
} from './first-party-relay-websocket'
import { firstPartyFetch } from './first-party-fetch'
import { getFirstPartyCaCertificates } from '../network/first-party-tls-trust'
import { exchangeOrcaCloudAuthCode } from '../orca-profiles/profile-cloud-client'
import { exchangeRelayAuthorization, requestRelayAssignment } from './relay/relay-http-client'

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WSS open timed out')), 5_000)
    const settle = (result: () => void): void => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('error', onError)
      result()
    }
    const onOpen = (): void => settle(resolve)
    const onError = (error: Error): void => settle(() => reject(error))
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(data.toString())
    }
    const onError = (error: Error): void => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      reject(error)
    }
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      socket.off('error', onError)
      reject(new Error('WSS message timed out'))
    }, 5_000)
    socket.once('message', onMessage)
    socket.once('error', onError)
  })
}

function socketError(socket: WebSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      resolve(error)
    }
    const onOpen = (): void => {
      clearTimeout(timer)
      socket.off('error', onError)
      socket.terminate()
      reject(new Error('unexpected WSS open'))
    }
    const timer = setTimeout(() => {
      socket.off('error', onError)
      socket.off('open', onOpen)
      reject(new Error('WSS error timed out'))
    }, 5_000)
    socket.once('error', onError)
    socket.once('open', onOpen)
  })
}

describe('first-party TLS trust', () => {
  const cloudRequests: { authorization: string | undefined; body: string }[] = []
  const relayRequests: { url: string; authorization: string | undefined; body: string }[] = []
  const server = createServer(
    { key: tlsFixture.key, cert: tlsFixture.certificate },
    (request, response) => {
      if (
        request.url === '/session' ||
        request.url === '/relay-token' ||
        request.url === '/v1/assign'
      ) {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          response.setHeader('content-type', 'application/json')
          if (request.url === '/session') {
            cloudRequests.push({ authorization: request.headers.authorization, body })
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
          relayRequests.push({
            url: request.url!,
            authorization: request.headers.authorization,
            body
          })
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
        })
        return
      }
      response.end('fixture-http-ok')
    }
  )
  const wss = new WebSocketServer({ server, perMessageDeflate: false })
  let httpsUrl: string
  let url: string

  beforeAll(async () => {
    wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)))
    await new Promise<void>((resolve) => server.listen(0, '::', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TLS fixture address')
    }
    httpsUrl = `https://localhost:${address.port}`
    url = `wss://localhost:${address.port}`
  })

  afterAll(async () => {
    for (const client of wss.clients) {
      client.terminate()
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('rejects the inspection certificate without additive trust', async () => {
    const socket = new WebSocket(url)
    const error = await socketError(socket)
    expect(error.message).toMatch(/certificate|self-signed|unable to verify/i)
  })

  it('uses additive system trust for first-party Node HTTP', async () => {
    await expect(globalThis.fetch(httpsUrl)).rejects.toThrow(/fetch failed/i)

    const response = await firstPartyFetch(httpsUrl)
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('fixture-http-ok')
  })

  it('keeps HTTP hostname verification enabled with additive trust', async () => {
    const mismatchedUrl = httpsUrl.replace('localhost', '[::1]')
    await expect(firstPartyFetch(mismatchedUrl)).rejects.toThrow(/fetch failed/i)
  })

  it('keeps WSS hostname verification enabled with additive trust', async () => {
    await prepareFirstPartyRelayWebSocketTrust(url)
    const socket = createFirstPartyRelayDataWebSocket(url.replace('localhost', '[::1]'))
    const error = await socketError(socket)
    expect(error.message).toMatch(/hostname|altname|IP/i)
  })

  it('carries the Cloud sign-in handoff through the real trusted HTTP boundary', async () => {
    cloudRequests.length = 0
    await expect(
      exchangeOrcaCloudAuthCode(
        {
          apiBaseUrl: httpsUrl,
          authorizeEndpoint: `${httpsUrl}/authorize`,
          sessionEndpoint: `${httpsUrl}/session`,
          refreshEndpoint: `${httpsUrl}/refresh`,
          capabilitiesEndpoint: `${httpsUrl}/capabilities`,
          profileEndpoint: `${httpsUrl}/profile`,
          orgEndpoint: `${httpsUrl}/org`,
          logoutEndpoint: `${httpsUrl}/logout`,
          relayTokenEndpoint: `${httpsUrl}/relay-token`,
          relayDirectorUrl: httpsUrl,
          clientId: 'fixture-client',
          scope: 'openid profile email offline_access'
        },
        {
          code: 'fixture-code',
          codeVerifier: 'fixture-verifier',
          nonce: 'fixture-nonce',
          redirectUri: 'orca://auth/callback',
          state: 'fixture-state',
          localProfileId: 'local-profile-1'
        }
      )
    ).resolves.toMatchObject({ accessToken: 'fixture-access-token' })
    expect(cloudRequests).toEqual([
      {
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
  })

  it('opens authenticated control and data sockets with additive trust', async () => {
    await prepareFirstPartyRelayWebSocketTrust(url)
    await expect(getFirstPartyCaCertificates()).resolves.toContain(tlsFixture.root)

    const controlRequest = new Promise<string | undefined>((resolve) =>
      wss.once('headers', (_headers, request) => resolve(request.headers.authorization))
    )
    const control = createFirstPartyRelayControlWebSocket(url, 'fixture-token')
    await opened(control)
    expect(await controlRequest).toBe('Bearer fixture-token')
    control.close()

    const data = createFirstPartyRelayDataWebSocket(url)
    await opened(data)
    const echoed = nextMessage(data)
    data.send('fixture-wss-ok')
    await expect(echoed).resolves.toBe('fixture-wss-ok')
    data.close()
  })

  it('carries Relay mint and assignment through the real trusted HTTP boundary', async () => {
    relayRequests.length = 0
    const keypair = nacl.box.keyPair()
    await expect(
      exchangeRelayAuthorization({
        endpoint: `${httpsUrl}/relay-token`,
        accessToken: 'fixture-access-token',
        keypair: {
          ...keypair,
          publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
        }
      })
    ).resolves.toMatchObject({ relayToken: 'fixture-relay-token' })
    await expect(
      requestRelayAssignment({
        directorUrl: httpsUrl,
        relayToken: 'fixture-relay-token',
        relayHostId: 'AbCdEf0123_-xyZ9'
      })
    ).resolves.toMatchObject({ assignmentEpoch: 3, cellUrl: httpsUrl })

    expect(relayRequests.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
      { url: '/relay-token', authorization: 'Bearer fixture-access-token' },
      { url: '/v1/assign', authorization: 'Bearer fixture-relay-token' }
    ])
    expect(JSON.parse(relayRequests[1]!.body)).toEqual({
      v: 1,
      relayHostId: 'AbCdEf0123_-xyZ9'
    })
  })
})

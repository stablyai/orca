import { createServer } from 'node:https'
import type * as NodeTls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { getFirstPartyCaCertificates } from './first-party-tls-trust'

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())))
}

describe('first-party TLS trust', () => {
  const server = createServer(
    { key: tlsFixture.key, cert: tlsFixture.certificate },
    (_req, res) => {
      res.end('fixture-http-ok')
    }
  )
  const wss = new WebSocketServer({ server, perMessageDeflate: false })
  let httpsUrl: string
  let url: string

  beforeAll(async () => {
    wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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
  })

  it('rejects the inspection certificate without additive trust', async () => {
    const socket = new WebSocket(url)
    const error = await new Promise<Error>((resolve) => socket.once('error', resolve))
    expect(error.message).toMatch(/certificate|self-signed|unable to verify/i)
  })

  it('uses additive system trust for first-party Node HTTP', async () => {
    await expect(globalThis.fetch(httpsUrl)).rejects.toThrow(/fetch failed/i)

    const response = await firstPartyFetch(httpsUrl)
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('fixture-http-ok')
  })

  it('opens authenticated control and data sockets with additive trust', async () => {
    prepareFirstPartyRelayWebSocketTrust(url)
    expect(getFirstPartyCaCertificates()).toContain(tlsFixture.root)

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
})

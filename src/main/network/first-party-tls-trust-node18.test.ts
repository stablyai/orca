import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeTls from 'node:tls'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
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
-----END CERTIFICATE-----`
}))

vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<typeof NodeTls>()
  return {
    ...original,
    getCACertificates: undefined,
    rootCertificates: []
  }
})

import { getFirstPartyCaCertificates } from './first-party-tls-trust'

let fixtureDirectory: string
let originalPlatform: PropertyDescriptor | undefined
let originalSslCertFile: string | undefined

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'orca-node18-ca-'))
  const bundlePath = join(fixtureDirectory, 'ca-certificates.crt')
  await writeFile(bundlePath, fixture.root)
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  originalSslCertFile = process.env.SSL_CERT_FILE
  Object.defineProperty(process, 'platform', { value: 'linux' })
  process.env.SSL_CERT_FILE = bundlePath
})

afterAll(async () => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  if (originalSslCertFile === undefined) {
    delete process.env.SSL_CERT_FILE
  } else {
    process.env.SSL_CERT_FILE = originalSslCertFile
  }
  await rm(fixtureDirectory, { recursive: true, force: true })
})

it('loads host OS trust when the Node 18 TLS API is unavailable', async () => {
  await expect(Promise.resolve(getFirstPartyCaCertificates())).resolves.toContain(fixture.root)
})

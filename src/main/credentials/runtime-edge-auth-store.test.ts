import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import {
  clearRuntimeEdgeAuth,
  getRuntimeEdgeAuthStatus,
  readRuntimeEdgeAuth,
  writeRuntimeEdgeAuth
} from './runtime-edge-auth-store'

let directory: string
let available = true
let gap: string | null = null
const key = randomBytes(32)
const environment = createEnvironmentFromPairingOffer({
  id: '../../unsafe-id',
  name: 'test-host',
  now: 1,
  offer: {
    v: 2,
    endpoint: 'wss://orca.example',
    deviceToken: 'synthetic-token',
    publicKeyB64: 'synthetic-key'
  }
})
const headers = { 'CF-Access-Client-Secret': 'synthetic-secret' }
function file() {
  return join(
    directory,
    'runtime-edge-auth',
    `${createHash('sha256').update(environment.id).digest('hex')}.json`
  )
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-runtime-edge-store-'))
  available = true
  gap = null
  setSecretStore({
    isEncryptionAvailable: () => available,
    describeProtectionGap: () => gap,
    encryptString: (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(
        'utf8'
      )
    }
  })
})
afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(directory, { recursive: true, force: true })
})

describe('encrypted runtime edge credential store', () => {
  it('encrypts and reloads origin-bound headers in an id-safe path', () => {
    expect(readRuntimeEdgeAuth(directory, environment)).toBeNull()
    writeRuntimeEdgeAuth(directory, environment, headers)
    expect(readFileSync(file(), 'utf8')).not.toContain('synthetic-secret')
    expect(readRuntimeEdgeAuth(directory, environment)).toEqual({
      origin: 'wss://orca.example',
      hostPublicKeyB64: 'synthetic-key',
      headers
    })
    expect(readdirSync(join(directory, 'runtime-edge-auth'))).toHaveLength(1)
    expect(getRuntimeEdgeAuthStatus(directory, environment)).toEqual({
      configured: true,
      unreadable: false
    })
    clearRuntimeEdgeAuth(directory, environment.id)
    expect(getRuntimeEdgeAuthStatus(directory, environment)).toEqual({
      configured: false,
      unreadable: false
    })
  })

  it.each(['unavailable', 'unprotected', 'corrupt'] as const)(
    'preserves old bytes when %s storage blocks replacement',
    (kind) => {
      writeRuntimeEdgeAuth(directory, environment, headers)
      if (kind === 'unavailable') {
        available = false
      }
      if (kind === 'unprotected') {
        gap = 'unprotected backend'
      }
      if (kind === 'corrupt') {
        writeFileSync(file(), 'synthetic-secret{')
      }
      const before = readFileSync(file())
      expect(() =>
        writeRuntimeEdgeAuth(directory, environment, { 'X-Token': 'replacement' })
      ).toThrow('Could not save edge authentication')
      expect(readFileSync(file())).toEqual(before)
      expect(getRuntimeEdgeAuthStatus(directory, environment)).toEqual({
        configured: true,
        unreadable: true
      })
    }
  )

  it.each(['endpoint', 'key'] as const)(
    'refuses a changed %s binding without deleting the old envelope',
    (kind) => {
      writeRuntimeEdgeAuth(directory, environment, headers)
      const changed = {
        ...environment,
        endpoints: environment.endpoints.map((entry) => ({
          ...entry,
          ...(kind === 'endpoint'
            ? { endpoint: 'wss://other.example' }
            : { publicKeyB64: 'other-key' })
        }))
      }
      expect(() => readRuntimeEdgeAuth(directory, changed)).toThrow(
        'Could not read edge authentication'
      )
      expect(readRuntimeEdgeAuth(directory, environment)?.headers).toEqual(headers)
    }
  )

  it('refuses insecure endpoints and invalid headers before publishing', () => {
    const insecure = {
      ...environment,
      endpoints: environment.endpoints.map((entry) => ({ ...entry, endpoint: 'ws://orca.example' }))
    }
    expect(() => writeRuntimeEdgeAuth(directory, insecure, headers)).toThrow(
      'Could not save edge authentication'
    )
    expect(() => writeRuntimeEdgeAuth(directory, environment, { 'X-Token': 'bad\nvalue' })).toThrow(
      'Could not save edge authentication'
    )
    expect(readRuntimeEdgeAuth(directory, environment)).toBeNull()
  })
})

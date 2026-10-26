import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { resolveRuntimeEnvironmentConnection } from '../runtime/runtime-environment-edge-auth'
import {
  clearRuntimeEdgeAuth,
  forgetRuntimeEdgeAuth,
  getRuntimeEdgeAuthStatus,
  readRuntimeEdgeAuth,
  writeRuntimeEdgeAuth
} from './runtime-edge-auth-store'

let directory: string
let available = true
let gap: string | null = null
let decryptions = 0
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
  decryptions = 0
  setSecretStore({
    isEncryptionAvailable: () => available,
    describeProtectionGap: () => gap,
    encryptString: (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptString: (bytes) => {
      decryptions += 1
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(
        'utf8'
      )
    }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  forgetRuntimeEdgeAuth(environment.id)
  _resetSecretStoreForTests()
  rmSync(directory, { recursive: true, force: true })
})

describe('encrypted runtime edge credential store', () => {
  it('decrypts credentials once across repeated connection resolutions', () => {
    writeRuntimeEdgeAuth(directory, environment, headers)
    for (let count = 0; count < 100; count += 1) {
      expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth?.headers).toEqual(
        headers
      )
    }
    expect(decryptions).toBe(1)
  })

  it('invalidates cached credentials after replacement, clear and explicit transport reset', () => {
    writeRuntimeEdgeAuth(directory, environment, headers)
    resolveRuntimeEnvironmentConnection(directory, environment)
    writeRuntimeEdgeAuth(directory, environment, { 'X-Token': 'replacement' })
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth?.headers).toEqual({
      'X-Token': 'replacement'
    })
    forgetRuntimeEdgeAuth(environment.id)
    available = false
    expect(() => resolveRuntimeEnvironmentConnection(directory, environment)).toThrow(
      'Could not read edge authentication'
    )
    available = true
    clearRuntimeEdgeAuth(directory, environment.id)
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth).toBeUndefined()
    writeRuntimeEdgeAuth(directory, environment, headers)
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth?.headers).toEqual(
      headers
    )
  })

  it('caches missing credentials until the connection cache is invalidated', () => {
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth).toBeUndefined()
    mkdirSync(join(directory, 'runtime-edge-auth'))
    writeFileSync(file(), 'invalid envelope')
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth).toBeUndefined()
    forgetRuntimeEdgeAuth(environment.id)
    expect(() => resolveRuntimeEnvironmentConnection(directory, environment)).toThrow(
      'Could not read edge authentication'
    )
  })

  it('forgets cached credentials when publication succeeds but durability fails', () => {
    writeRuntimeEdgeAuth(directory, environment, headers)
    resolveRuntimeEnvironmentConnection(directory, environment)
    const write = secureFile.writeSecureFile
    vi.spyOn(secureFile, 'writeSecureFile').mockImplementationOnce((...args) => {
      write(...args)
      throw new Error('Directory sync failed after publication')
    })
    expect(() =>
      writeRuntimeEdgeAuth(directory, environment, { 'X-Token': 'replacement' })
    ).toThrow('Could not save edge authentication')
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth?.headers).toEqual({
      'X-Token': 'replacement'
    })
  })

  it('rechecks credentials for changed pairing revisions and device tokens', () => {
    writeRuntimeEdgeAuth(directory, environment, headers)
    resolveRuntimeEnvironmentConnection(directory, environment)
    resolveRuntimeEnvironmentConnection(directory, {
      ...environment,
      pairingRevision: 2
    })
    resolveRuntimeEnvironmentConnection(directory, {
      ...environment,
      pairingRevision: 2,
      endpoints: environment.endpoints.map((entry) => ({ ...entry, deviceToken: 'new-token' }))
    })
    expect(decryptions).toBe(3)
  })

  it.each(['endpoint', 'key'] as const)('never reuses a cached changed %s binding', (kind) => {
    writeRuntimeEdgeAuth(directory, environment, headers)
    resolveRuntimeEnvironmentConnection(directory, environment)
    const changed = {
      ...environment,
      endpoints: environment.endpoints.map((entry) => ({
        ...entry,
        ...(kind === 'endpoint'
          ? { endpoint: 'wss://other.example' }
          : { publicKeyB64: 'other-key' })
      }))
    }
    expect(() => resolveRuntimeEnvironmentConnection(directory, changed)).toThrow(
      'Could not read edge authentication'
    )
  })

  it('isolates profiles and retries failed reads after protected storage unlocks', () => {
    writeRuntimeEdgeAuth(directory, environment, headers)
    available = false
    expect(() => resolveRuntimeEnvironmentConnection(directory, environment)).toThrow(
      'Could not read edge authentication'
    )
    available = true
    expect(resolveRuntimeEnvironmentConnection(directory, environment).edgeAuth?.headers).toEqual(
      headers
    )
    expect(
      resolveRuntimeEnvironmentConnection(join(directory, 'other-profile'), environment).edgeAuth
    ).toBeUndefined()
  })

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

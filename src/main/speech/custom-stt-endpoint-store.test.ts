import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock, secretStoreMock } = vi.hoisted(() => ({
  homedirMock: vi.fn(),
  secretStoreMock: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
    describeProtectionGap: vi.fn(() => null)
  }
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: homedirMock
}))

vi.mock('../../shared/secret-store', () => ({
  getSecretStore: () => secretStoreMock
}))

import {
  clearCustomSttEndpointConfig,
  hasCustomSttEndpoint,
  readCustomSttEndpointApiKey,
  readCustomSttEndpointConfig,
  resolveCustomSttTranscriptionUrl,
  saveCustomSttEndpointApiKey,
  saveCustomSttEndpointConfig
} from './custom-stt-endpoint-store'

describe('custom stt endpoint store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-custom-stt-'))
    homedirMock.mockReturnValue(dir)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    clearCustomSttEndpointConfig()
  })

  afterEach(() => {
    clearCustomSttEndpointConfig()
    rmSync(dir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('round-trips base url and model', () => {
    saveCustomSttEndpointConfig({ baseUrl: 'http://127.0.0.1:8090/v1/', model: 'large-v3' })

    expect(readCustomSttEndpointConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:8090/v1',
      model: 'large-v3'
    })
    expect(hasCustomSttEndpoint()).toBe(true)
  })

  it('rejects non-http(s) and malformed urls', () => {
    expect(() =>
      saveCustomSttEndpointConfig({ baseUrl: 'ftp://host/v1', model: 'large-v3' })
    ).toThrow(/http or https/)
    expect(() => saveCustomSttEndpointConfig({ baseUrl: 'not a url', model: 'large-v3' })).toThrow()
    expect(() => saveCustomSttEndpointConfig({ baseUrl: 'http://h/v1', model: '  ' })).toThrow(
      /model/
    )
  })

  it('appends the transcription path unless the url already names it', () => {
    expect(resolveCustomSttTranscriptionUrl('http://h:8090/v1')).toBe(
      'http://h:8090/v1/audio/transcriptions'
    )
    expect(resolveCustomSttTranscriptionUrl('http://h:8090/v1/audio/transcriptions')).toBe(
      'http://h:8090/v1/audio/transcriptions'
    )
  })

  it('treats a missing token as unauthenticated rather than an error', () => {
    saveCustomSttEndpointConfig({ baseUrl: 'http://h:8090/v1', model: 'large-v3' })
    expect(readCustomSttEndpointApiKey()).toBeNull()
  })

  it('persists and reads an optional bearer token', () => {
    saveCustomSttEndpointApiKey('token-123')
    expect(readCustomSttEndpointApiKey()).toBe('token-123')
  })
})

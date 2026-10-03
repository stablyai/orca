import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasContent: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readStored: vi.fn(),
  writeEncrypted: vi.fn()
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: mocks.mkdir,
  readFileSync: mocks.readFile,
  unlinkSync: vi.fn()
}))

vi.mock('node:os', () => ({ homedir: () => '/test-home' }))

vi.mock('../integration-credential-file', () => ({
  credentialFileHasContent: mocks.hasContent,
  readStoredCredentialToken: mocks.readStored,
  writeEncryptedCredential: mocks.writeEncrypted
}))

import { readSentryCredential, saveSentryCredential } from './credential-store'

const ORGANIZATION = { id: '1', slug: 'acme', name: 'Acme' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Sentry credential store', () => {
  it('writes the token and connection metadata as one encrypted record', () => {
    saveSentryCredential(
      'secret',
      { baseUrl: 'https://sentry.example', organization: ORGANIZATION },
      [ORGANIZATION]
    )

    expect(mocks.writeEncrypted).toHaveBeenCalledOnce()
    const [service, path, serialized] = mocks.writeEncrypted.mock.calls[0]
    expect({ service, path }).toEqual({
      service: 'Sentry',
      path: '/test-home/.orca/sentry-credential.enc'
    })
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      token: 'secret',
      baseUrl: 'https://sentry.example',
      organization: ORGANIZATION,
      organizations: [ORGANIZATION]
    })
  })

  it('reads the complete encrypted record without consulting legacy files', () => {
    const serialized = JSON.stringify({
      version: 1,
      token: 'secret',
      baseUrl: 'https://sentry.example',
      organization: ORGANIZATION,
      organizations: [ORGANIZATION]
    })
    mocks.hasContent.mockReturnValue(true)
    mocks.readFile.mockReturnValue(Buffer.from('encrypted'))
    mocks.readStored.mockReturnValue(serialized)

    expect(readSentryCredential()).toEqual(JSON.parse(serialized))
    expect(mocks.readFile).toHaveBeenCalledOnce()
  })
})

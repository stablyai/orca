import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tokenDir = join(tmpdir(), `orca-redmine-test-${process.pid}`)

vi.mock('../integration-credential-file', () => ({
  writeEncryptedCredential: vi.fn()
}))

vi.mock('./redmine-credential-paths', () => ({
  getRedmineSiteFilePath: () => join(tokenDir, '..', 'redmine-sites.json'),
  getRedmineTokenDir: () => tokenDir,
  getRedmineTokenPath: (id: string) => join(tokenDir, `${id}.enc`)
}))

import { writeEncryptedCredential } from '../integration-credential-file'
import { saveToken } from './redmine-site-store'

const writeEncryptedCredentialMock = vi.mocked(writeEncryptedCredential)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  // leave the token dir in place so subsequent reads are deterministic
})

describe('saveToken', () => {
  it('creates the token directory before writing the credential', () => {
    // pre-existing failure: write to ~/.orca/redmine-tokens/<id>.enc ENOENT
    // because the token directory was never created.
    saveToken('site-1', 'secret-token')

    expect(existsSync(tokenDir)).toBe(true)
    expect(writeEncryptedCredentialMock).toHaveBeenCalledWith(
      'Redmine',
      join(tokenDir, 'site-1.enc'),
      'secret-token'
    )
  })

  it('is idempotent when the token directory already exists', () => {
    mkdirSync(tokenDir, { recursive: true })
    saveToken('site-1', 'secret-token')
    expect(writeEncryptedCredentialMock).toHaveBeenCalled()
  })
})

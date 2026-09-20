import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_IDENTITY_MODE_FILE,
  BROWSER_IDENTITY_MODE_VERSION,
  readBrowserIdentityModeRecord
} from './browser-identity-mode-record'

function makeUserData(): string {
  return mkdtempSync(join(tmpdir(), 'orca-browser-identity-'))
}

function writeRecord(userDataPath: string, value: unknown): void {
  writeFileSync(join(userDataPath, BROWSER_IDENTITY_MODE_FILE), JSON.stringify(value), 'utf8')
}

describe('readBrowserIdentityModeRecord', () => {
  it('distinguishes missing data as implicit clean', () => {
    expect(readBrowserIdentityModeRecord(makeUserData())).toEqual({
      state: 'missing',
      appliedMode: 'clean',
      configuredMode: 'clean',
      explicitSelection: false,
      migrationNoticePending: false
    })
  })

  it('returns a valid configured identity', () => {
    const userDataPath = makeUserData()
    writeRecord(userDataPath, {
      version: BROWSER_IDENTITY_MODE_VERSION,
      mode: 'native',
      explicitSelection: true,
      migrationNoticePending: true
    })

    expect(readBrowserIdentityModeRecord(userDataPath)).toEqual({
      state: 'valid',
      appliedMode: 'native',
      configuredMode: 'native',
      explicitSelection: true,
      migrationNoticePending: true
    })
  })

  it('falls back to clean without inventing a configured mode for corrupt data', () => {
    const userDataPath = makeUserData()
    writeFileSync(join(userDataPath, BROWSER_IDENTITY_MODE_FILE), '{not json', 'utf8')

    expect(readBrowserIdentityModeRecord(userDataPath)).toEqual({
      state: 'corrupt',
      appliedMode: 'clean',
      configuredMode: null,
      explicitSelection: null,
      migrationNoticePending: null
    })
  })

  it('distinguishes a future record from corrupt data', () => {
    const userDataPath = makeUserData()
    writeRecord(userDataPath, {
      version: BROWSER_IDENTITY_MODE_VERSION + 1,
      mode: 'native',
      explicitSelection: true,
      migrationNoticePending: false
    })

    expect(readBrowserIdentityModeRecord(userDataPath)).toEqual({
      state: 'future',
      appliedMode: 'clean',
      configuredMode: null,
      explicitSelection: null,
      migrationNoticePending: null
    })
  })

  it('distinguishes an unreadable record from missing data', () => {
    const userDataPath = makeUserData()
    mkdirSync(join(userDataPath, BROWSER_IDENTITY_MODE_FILE))

    expect(readBrowserIdentityModeRecord(userDataPath)).toEqual({
      state: 'unreadable',
      appliedMode: 'clean',
      configuredMode: null,
      explicitSelection: null,
      migrationNoticePending: null
    })
  })
})

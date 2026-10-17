import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IncognitoPasscodeStore } from './incognito-passcode-store'

describe('IncognitoPasscodeStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-incognito-'))
    filePath = join(dir, 'incognito-passcode.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('verifies the passcode it stored and never writes it in plain text', async () => {
    const store = new IncognitoPasscodeStore(filePath)
    await expect(store.hasPasscode()).resolves.toBe(false)
    await store.setPasscode('correct horse')
    await expect(store.hasPasscode()).resolves.toBe(true)
    await expect(store.verify('correct horse')).resolves.toBe(true)
    await expect(store.verify('wrong horse')).resolves.toBe(false)
    expect(readFileSync(filePath, 'utf-8')).not.toContain('correct horse')
  })

  it('rejects a too-short passcode', async () => {
    await expect(new IncognitoPasscodeStore(filePath).setPasscode('abc')).rejects.toThrow()
  })

  it('treats a corrupt file as no passcode', async () => {
    writeFileSync(filePath, '{not json')
    const store = new IncognitoPasscodeStore(filePath)
    await expect(store.hasPasscode()).resolves.toBe(false)
    await expect(store.verify('anything')).resolves.toBe(false)
  })
})

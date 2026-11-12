import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDevinLoginWithCredentialCapture } from './devin-login-credential-capture'

let root: string
let appData: string
let dataHome: string
let hostCredential: string
let sandboxCredential: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-devin-login-capture-'))
  appData = join(root, 'appdata')
  dataHome = join(root, 'data')
  hostCredential = join(appData, 'devin', 'credentials.toml')
  sandboxCredential = join(dataHome, 'devin', 'credentials.toml')
  mkdirSync(join(appData, 'devin'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Devin Windows account login credential capture', () => {
  it('captures Devin’s AppData credential and restores the existing host login', async () => {
    writeFileSync(hostCredential, 'windsurf_api_key = "existing"\n')

    await runDevinLoginWithCredentialCapture(
      dataHome,
      async (extraEnv) => {
        expect(extraEnv.APPDATA).toBe(dataHome)
        mkdirSync(join(appData, 'devin'), { recursive: true })
        writeFileSync(hostCredential, 'windsurf_api_key = "new"\n')
      },
      { platform: 'win32', appDataRoot: appData }
    )

    expect(readFileSync(sandboxCredential, 'utf8')).toBe('windsurf_api_key = "new"\n')
    expect(readFileSync(hostCredential, 'utf8')).toBe('windsurf_api_key = "existing"\n')
    expect(readdirSync(join(appData, 'devin')).some((name) => name.endsWith('.bak'))).toBe(false)
  })

  it('removes a host credential written during login when no host login existed', async () => {
    await runDevinLoginWithCredentialCapture(
      dataHome,
      async () => {
        writeFileSync(hostCredential, 'windsurf_api_key = "new"\n')
      },
      { platform: 'win32', appDataRoot: appData }
    )

    expect(readFileSync(sandboxCredential, 'utf8')).toBe('windsurf_api_key = "new"\n')
    expect(existsSync(hostCredential)).toBe(false)
  })

  it('restores the previous host login when Devin login fails', async () => {
    writeFileSync(hostCredential, 'windsurf_api_key = "existing"\n')

    await expect(
      runDevinLoginWithCredentialCapture(
        dataHome,
        async () => {
          rmSync(hostCredential, { force: true })
          throw new Error('login failed')
        },
        { platform: 'win32', appDataRoot: appData }
      )
    ).rejects.toThrow('login failed')

    expect(readFileSync(hostCredential, 'utf8')).toBe('windsurf_api_key = "existing"\n')
  })
})

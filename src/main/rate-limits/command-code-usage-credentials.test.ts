import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMAND_CODE_AUTH_FILE_NAME,
  COMMAND_CODE_ENV_CREDENTIAL_SOURCE,
  getCommandCodeAuthFilePath,
  readCommandCodeUsageCredentials
} from './command-code-usage-credentials'
import type { CommandCodeHomeResolution } from '../command-code/command-code-runtime-home'

let home: string
let hostHome: CommandCodeHomeResolution

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-command-code-credentials-'))
  hostHome = { runtime: 'host', wslDistro: null, path: home }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('readCommandCodeUsageCredentials', () => {
  it('reads the CLI login and hashes its identity into the read', async () => {
    writeFileSync(
      join(home, COMMAND_CODE_AUTH_FILE_NAME),
      JSON.stringify({ apiKey: 'file-key', userId: 'u1', userName: 'dev' })
    )

    const read = await readCommandCodeUsageCredentials({ home: hostHome })

    expect(read.status).toBe('ok')
    if (read.status !== 'ok') {
      return
    }
    expect(read.credentials.apiKey).toBe('file-key')
    expect(read.credentials.source).toBe(join(home, COMMAND_CODE_AUTH_FILE_NAME))
    expect(read.credentials.authProvenance).toMatch(/^[a-f0-9]{64}$/)
    expect(read.credentials.authProvenance).not.toContain('file-key')
  })

  it('reports missing without an auth file', async () => {
    const read = await readCommandCodeUsageCredentials({ home: hostHome })

    expect(read.status).toBe('missing')
  })

  it('reports an error for a file that is not JSON', async () => {
    writeFileSync(join(home, COMMAND_CODE_AUTH_FILE_NAME), 'not json')

    const read = await readCommandCodeUsageCredentials({ home: hostHome })

    expect(read).toMatchObject({ status: 'error' })
  })

  it('rejects an auth file whose key is unusable', async () => {
    writeFileSync(join(home, COMMAND_CODE_AUTH_FILE_NAME), JSON.stringify({ apiKey: 'bad\r\nkey' }))

    const read = await readCommandCodeUsageCredentials({ home: hostHome })

    expect(read.status).toBe('error')
  })

  it('prefers COMMAND_CODE_API_KEY on the host runtime', async () => {
    writeFileSync(join(home, COMMAND_CODE_AUTH_FILE_NAME), JSON.stringify({ apiKey: 'file-key' }))
    vi.stubEnv('COMMAND_CODE_API_KEY', 'env-key')

    const read = await readCommandCodeUsageCredentials({ home: hostHome })

    expect(read.status).toBe('ok')
    if (read.status !== 'ok') {
      return
    }
    expect(read.credentials.apiKey).toBe('env-key')
    expect(read.credentials.source).toBe(COMMAND_CODE_ENV_CREDENTIAL_SOURCE)
  })

  it('ignores the host env override for a WSL target', async () => {
    vi.stubEnv('COMMAND_CODE_API_KEY', 'env-key')

    const read = await readCommandCodeUsageCredentials({
      home: {
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.commandcode'
      }
    })

    // The UNC share is unreadable off Windows, so the distro's own file must not
    // be answered from this process environment.
    expect(read).not.toMatchObject({ status: 'ok' })
  })
})

describe('getCommandCodeAuthFilePath', () => {
  it('joins a host path with the platform separator', () => {
    expect(getCommandCodeAuthFilePath(join('/home', 'dev', '.commandcode'))).toBe(
      join('/home', 'dev', '.commandcode', COMMAND_CODE_AUTH_FILE_NAME)
    )
  })

  it('keeps a WSL UNC path intact', () => {
    expect(getCommandCodeAuthFilePath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.commandcode')).toBe(
      `\\\\wsl.localhost\\Ubuntu\\home\\dev\\.commandcode\\${COMMAND_CODE_AUTH_FILE_NAME}`
    )
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { readCcSwitchZhipuCredentials } from './cc-switch-import'

type ProviderEnv = {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_AUTH_TOKEN?: string
}

describe('readCcSwitchZhipuCredentials', () => {
  let rootDir: string
  let ccSwitchDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'orca-cc-switch-'))
    ccSwitchDir = join(rootDir, '.cc-switch')
    mkdirSync(ccSwitchDir)
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function writeSettings(providerName?: string): void {
    writeFileSync(
      join(ccSwitchDir, 'settings.json'),
      JSON.stringify(providerName ? { currentProviderClaude: providerName } : {})
    )
  }

  function writeProvider(name: string, env: ProviderEnv): void {
    const db = new SyncDatabase(join(ccSwitchDir, 'cc-switch.db'))
    try {
      db.exec('CREATE TABLE providers (name TEXT, app_type TEXT, settings_config TEXT)')
      db.prepare('INSERT INTO providers (name, app_type, settings_config) VALUES (?, ?, ?)').run(
        name,
        'claude',
        JSON.stringify({ env })
      )
    } finally {
      db.close()
    }
  }

  it('imports the current cc-switch Claude provider when it targets Zhipu', () => {
    writeSettings('bigmodel')
    writeProvider('bigmodel', {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic/',
      ANTHROPIC_AUTH_TOKEN: 'zai-token'
    })

    expect(readCcSwitchZhipuCredentials({ ccSwitchDir })).toEqual({
      providerName: 'bigmodel',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      authToken: 'zai-token'
    })
  })

  it('uses the cc-switch default provider when settings omit a current Claude provider', () => {
    writeSettings()
    writeProvider('default', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'zai-token'
    })

    expect(readCcSwitchZhipuCredentials({ ccSwitchDir }).providerName).toBe('default')
  })

  it('rejects non-Zhipu providers without returning their token', () => {
    writeSettings('anthropic')
    writeProvider('anthropic', {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token'
    })

    expect(() => readCcSwitchZhipuCredentials({ ccSwitchDir })).toThrow(/not a zhipu/i)
  })

  it('rejects providers without an auth token', () => {
    writeSettings('bigmodel')
    writeProvider('bigmodel', {
      ANTHROPIC_BASE_URL: 'https://dev.bigmodel.cn/api/anthropic'
    })

    expect(() => readCcSwitchZhipuCredentials({ ccSwitchDir })).toThrow(
      /missing ANTHROPIC_AUTH_TOKEN/
    )
  })

  it('rejects providers without a base URL', () => {
    writeSettings('bigmodel')
    writeProvider('bigmodel', {
      ANTHROPIC_AUTH_TOKEN: 'zai-token'
    })

    expect(() => readCcSwitchZhipuCredentials({ ccSwitchDir })).toThrow(
      /missing ANTHROPIC_BASE_URL/
    )
  })
})

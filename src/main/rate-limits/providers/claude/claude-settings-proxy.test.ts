import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClaudeSettingsProxy } from './claude-settings-proxy'

let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'orca-claude-settings-proxy-'))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

function writeSettings(value: unknown): void {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(value))
}

describe('readClaudeSettingsProxy', () => {
  it("reads the proxy and bypass list from the account's settings.json env", async () => {
    writeSettings({
      env: {
        HTTP_PROXY: 'http://127.0.0.1:1111',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        NO_PROXY: 'localhost,.internal'
      }
    })

    await expect(readClaudeSettingsProxy(configDir)).resolves.toEqual({
      httpProxyUrl: 'http://127.0.0.1:7890',
      httpProxyBypassRules: 'localhost;.internal'
    })
  })

  it.each([
    { name: 'no settings file', settings: undefined },
    { name: 'no env', settings: { model: 'opus' } },
    { name: 'no proxy keys', settings: { env: { ANTHROPIC_MODEL: 'opus' } } },
    { name: 'an invalid proxy', settings: { env: { HTTPS_PROXY: 'ftp://127.0.0.1:21' } } }
  ])('returns null with $name', async ({ settings }) => {
    if (settings !== undefined) {
      writeSettings(settings)
    }

    await expect(readClaudeSettingsProxy(configDir)).resolves.toBeNull()
  })
})

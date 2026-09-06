import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'jsonc-parser'
import { planGeminiConfig } from './chrome-devtools-gemini'
import { configureChromeDevtools } from './chrome-devtools-setup'

const roots: string[] = []
function fixture(contents?: string) {
  const home = mkdtempSync(join(tmpdir(), 'orca-gemini-mcp-test-'))
  roots.push(home)
  const file = join(home, '.gemini', 'settings.json')
  if (contents !== undefined) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return { home, file }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Gemini Chrome DevTools config', () => {
  it('preserves JSONC comments and settings with an atomic backup and idempotence', async () => {
    const original =
      '{\n // preserve theme\n "ui":{"theme":"custom"},\n "mcpServers":{"other":{"command":"other"}},\n}\n'
    const { home, file } = fixture(original)
    const result = await configureChromeDevtools({
      agent: 'gemini',
      apply: true,
      home,
      env: {},
      platform: 'linux'
    })
    expect(readFileSync(result.configs[0].backupPath!, 'utf8')).toBe(original)
    const updated = readFileSync(file, 'utf8')
    expect(updated).toContain('// preserve theme')
    expect(parse(updated).mcpServers['chrome-devtools']).toMatchObject({
      command: 'npx',
      timeout: 60000
    })
    expect(parse(updated).ui.theme).toBe('custom')
    expect(planGeminiConfig(home, {}, 'linux').after).toBe(updated)
  })
  it('treats GEMINI_CLI_HOME as the parent of .gemini and leaves defaults untouched', () => {
    const { home } = fixture()
    const override = join(home, 'override')
    expect(planGeminiConfig(home, { GEMINI_CLI_HOME: override }, 'win32').configPath).toBe(
      join(override, '.gemini', 'settings.json')
    )
    expect(existsSync(join(home, '.gemini'))).toBe(false)
    expect(() => planGeminiConfig(home, { GEMINI_CLI_HOME: 'relative' }, 'linux')).toThrow(
      'absolute'
    )
  })
  it.each([
    { admin: { mcp: { enabled: false } } },
    { mcp: { allowed: ['other'] } },
    { mcp: { excluded: ['chrome-devtools'] } },
    { mcpServers: { 'chrome-devtools': { command: 'other' } } }
  ])('fails closed on policy restrictions or existing conflicts: %j', (config) => {
    const original = JSON.stringify(config)
    const { home, file } = fixture(original)
    expect(() => planGeminiConfig(home, {}, 'linux')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(original)
  })
  it('rejects explicit system overrides instead of claiming effective setup', () => {
    const { home } = fixture()
    expect(() =>
      planGeminiConfig(home, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/system' }, 'linux')
    ).toThrow('system config overrides')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFile from '../shared/secure-file'
import type * as Fs from 'node:fs'
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof Fs>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('../shared/secure-file', async (original) => {
  const actual = await original<typeof SecureFile>()
  return { ...actual, writeSecureFile: vi.fn(actual.writeSecureFile) }
})
import { writeSecureFile } from '../shared/secure-file'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { AddApiProviderAccountSchema } from '../shared/api-provider-account'
import {
  API_PROVIDER_ACCOUNT_FILE,
  assertApiProviderAccountHome,
  preserveClaudeApiProviderSettings,
  readApiProviderAccount,
  saveApiProviderAccount
} from './api-provider-account'
import { syncSystemConfigIntoManagedCodexHome } from './codex/codex-config-mirror'

const homes: string[] = []
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-api-account-'))
  homes.push(home)
  return home
}
const input = {
  label: 'Surplus',
  baseUrl: 'https://api.surplusintelligence.ai/v1',
  model: 'gpt-6.1-sol',
  apiKey: 'inf_test_key'
}
afterEach(() => {
  vi.clearAllMocks()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

describe('API provider account isolation', () => {
  it('keeps provider selection, model changes, and API credentials out of System default through repeated mirrors', () => {
    const systemHomePath = tempHome()
    const runtimeHomePath = tempHome()
    const canonical = 'model = "subscription-model"\nmodel_provider = "openai"\n'
    const personalAuth = JSON.stringify({ tokens: { refresh_token: 'personal-refresh' } })
    writeFileSync(join(systemHomePath, 'config.toml'), canonical)
    writeFileSync(join(systemHomePath, 'auth.json'), personalAuth)
    saveApiProviderAccount(runtimeHomePath, input, 'codex')
    const homes = { systemHomePath, runtimeHomePath }
    syncSystemConfigIntoManagedCodexHome(homes)
    const first = parse(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf8'))
    expect(first).toMatchObject({
      model: input.model,
      model_provider: 'orca_api_account',
      model_providers: { orca_api_account: { base_url: input.baseUrl } }
    })
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      readFileSync(join(runtimeHomePath, 'config.toml'), 'utf8').replace(
        input.model,
        'another-api-model'
      )
    )
    syncSystemConfigIntoManagedCodexHome(homes)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf8')).toBe(canonical)
    expect(readFileSync(join(systemHomePath, 'auth.json'), 'utf8')).toBe(personalAuth)
    expect(JSON.parse(readFileSync(join(runtimeHomePath, 'auth.json'), 'utf8'))).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: input.apiKey
    })
    expect(readApiProviderAccount(runtimeHomePath)).not.toHaveProperty('apiKey')
    if (process.platform !== 'win32') {
      expect(statSync(join(runtimeHomePath, 'auth.json')).mode & 0o777).toBe(0o600)
    }
  })

  it("refreshes shared Claude settings while preserving only that account's provider credentials", () => {
    const home = tempHome()
    const settingsPath = join(home, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          UNRELATED: 'old',
          CLAUDE_CODE_USE_BEDROCK: '1',
          CLAUDE_CODE_OAUTH_TOKEN: 'personal-oauth'
        }
      })
    )
    const provider = saveApiProviderAccount(
      home,
      {
        ...input,
        baseUrl: 'https://api.surplusintelligence.ai/anthropic',
        model: 'claude-sonnet-5.5'
      },
      'claude'
    )
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('personal-oauth')
    const current = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const source = {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'different-account',
        UNRELATED: 'new',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer personal-token'
      },
      hooks: { Stop: [] }
    }
    const refreshed = preserveClaudeApiProviderSettings(home, source, current)
    expect(refreshed).toMatchObject({
      hooks: source.hooks,
      env: {
        UNRELATED: 'new',
        CLAUDE_CODE_USE_BEDROCK: '',
        CLAUDE_CODE_USE_VERTEX: '',
        CLAUDE_CODE_USE_FOUNDRY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_CUSTOM_HEADERS: '',
        ANTHROPIC_AUTH_TOKEN: input.apiKey,
        ANTHROPIC_BASE_URL: provider.baseUrl,
        ANTHROPIC_MODEL: provider.model
      }
    })
    expect(source.env.ANTHROPIC_AUTH_TOKEN).toBe('different-account')
    expect(() => preserveClaudeApiProviderSettings(home, source, {})).toThrow(/key is missing/)
  })

  it('does not alter subscription profile settings', () => {
    const source = { env: { ANTHROPIC_AUTH_TOKEN: 'original' } }
    expect(preserveClaudeApiProviderSettings(tempHome(), source, {})).toBe(source)
  })

  it('refuses a missing API sidecar during generic maintenance without promoting its provider', () => {
    const systemHomePath = tempHome()
    const runtimeHomePath = tempHome()
    const canonical = 'model = "subscription-model"\nmodel_provider = "openai"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), canonical)
    const homes = { systemHomePath, runtimeHomePath }
    syncSystemConfigIntoManagedCodexHome(homes)
    saveApiProviderAccount(runtimeHomePath, input, 'codex')
    syncSystemConfigIntoManagedCodexHome(homes)
    const runtimeBefore = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf8')
    rmSync(join(runtimeHomePath, API_PROVIDER_ACCOUNT_FILE))
    expect(() => syncSystemConfigIntoManagedCodexHome(homes)).toThrow(/API account/)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf8')).toBe(canonical)
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf8')).toBe(runtimeBefore)
  })

  it('refuses credentials when private permissions cannot be enforced', () => {
    const home = tempHome()
    vi.mocked(writeSecureFile).mockReturnValueOnce(false)
    expect(() => saveApiProviderAccount(home, input, 'codex')).toThrow(/private permissions/)
    expect(readApiProviderAccount(home)).toBeNull()
  })

  it('distinguishes unreadable provider metadata from absence without exposing malformed bytes', () => {
    const home = tempHome()
    expect(readApiProviderAccount(home)).toBeNull()
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    expect(() => readApiProviderAccount(home)).toThrow(/could not be read/)
    writeFileSync(join(home, API_PROVIDER_ACCOUNT_FILE), '{"secret":"inf_do_not_echo')
    expect(() => readApiProviderAccount(home)).toThrow(/^The API account configuration is invalid/)
    try {
      readApiProviderAccount(home)
    } catch (error) {
      expect(String(error)).not.toContain('inf_do_not_echo')
    }
  })

  it('rejects missing credentials and changed provider metadata before launch', () => {
    const home = tempHome()
    const provider = saveApiProviderAccount(home, input, 'codex')
    expect(() => assertApiProviderAccountHome(home, provider, 'codex')).not.toThrow()
    rmSync(join(home, 'auth.json'))
    expect(() => assertApiProviderAccountHome(home, provider, 'codex')).toThrow(/key is missing/)
    writeFileSync(
      join(home, API_PROVIDER_ACCOUNT_FILE),
      JSON.stringify({ ...provider, baseUrl: 'https://elsewhere.test/v1' })
    )
    expect(() => assertApiProviderAccountHome(home, provider)).toThrow(
      /configuration is missing or changed/
    )
  })

  it('rejects endpoints with insecure transport or embedded credentials', () => {
    for (const baseUrl of [
      'http://example.com/v1',
      'https://user:secret@example.com/v1',
      'https://example.com/v1?key=secret'
    ]) {
      expect(AddApiProviderAccountSchema.safeParse({ ...input, baseUrl }).success).toBe(false)
    }
  })
})

// image/vm/orca-sandbox-env run for real (bash), against a scratch HOME: the Codex account placeholder
// login (contract D11) and the managed ~/.codex/config.toml staying stable across refreshes.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { codexPlaceholder } from '../src/codex-credentials'

const SCRIPT = fileURLToPath(new URL('../image/vm/orca-sandbox-env', import.meta.url).href)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'orca-sandbox-env-'))
  dirs.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  let generation = 1
  const run = (secrets: Record<string, string>) => {
    const encoded = Object.entries(secrets)
      .map(([name, value]) => `${name}=${Buffer.from(value).toString('base64')}`)
      .join('\n')
    execFileSync('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ORCA_SESSION_ENV_DIR: join(root, 'shm'),
        ORCA_SECRET_ENV: encoded,
        ORCA_ENV_GENERATION: String(generation++),
        ORCA_CODEX_SYSTEM_CONFIG: join(root, 'etc-codex', 'config.toml')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }
  const file = (path: string) => (existsSync(join(home, path)) ? readFileSync(join(home, path), 'utf8') : null)
  const systemConfig = () => (existsSync(join(root, 'etc-codex', 'config.toml')) ? readFileSync(join(root, 'etc-codex', 'config.toml'), 'utf8') : null)
  return { home, run, file, systemConfig, sessionEnv: () => readFileSync(join(root, 'shm', 'session.env'), 'utf8') }
}

describe('orca-sandbox-env: Codex via the Orca account', () => {
  it('Codex never refreshes the placeholder itself, keeps HTTPS at the system layer, and has plugins off (CODEX-FIREWALL-SWAP)', () => {
    const { run, file, systemConfig } = scratch()
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_1' }) })
    expect(JSON.parse(file('.codex/auth.json')!).last_refresh).toBe('2099-01-01T00:00:00Z')
    const system = systemConfig()!
    expect(system).toContain('[model_providers.orca_chatgpt]')
    expect(system).toContain('supports_websockets = false')
    expect(file('.codex/config.toml')).toContain('[features]\nplugins = false\n')
  })

  it("a person's own [features] table is left alone: no second one (invalid TOML), plugins as they set them", () => {
    const { home, run, file } = scratch()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), '[features]\nplugins = true\n')
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_1' }) })
    const config = file('.codex/config.toml')!
    expect(config.match(/^\[features\]/gm)).toHaveLength(1)
    expect(config).toContain('plugins = true')
    expect(config).not.toContain('plugins = false')
  })

  it('no Orca account: no plugins override and no system provider', () => {
    const { run, file, systemConfig } = scratch()
    run({})
    expect(file('.codex/config.toml') ?? '').not.toContain('plugins = false')
    expect(systemConfig()).toBeNull()
  })

  it('writes a placeholder ChatGPT login (no refresh token) and the HTTPS provider, never as a shell variable', () => {
    const { run, file, sessionEnv } = scratch()
    const placeholder = codexPlaceholder({ id: 'sbx_1' })
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: placeholder, FOO: 'bar' })
    const auth = JSON.parse(file('.codex/auth.json')!)
    expect(auth.tokens).toEqual({ id_token: placeholder, access_token: placeholder, refresh_token: '', account_id: null })
    expect(auth.OPENAI_API_KEY).toBeNull()
    expect(file('.codex/config.toml')).toContain('model_provider = "orca_chatgpt"')
    expect(file('.codex/config.toml')).toContain('supports_websockets = false')
    expect(sessionEnv()).not.toContain('ORCA_CODEX')
    expect(sessionEnv()).toContain('FOO=')
  })

  it("sets a person's own login aside while the account applies and puts it back after; a clone gets its own placeholder", () => {
    const { home, run, file } = scratch()
    mkdirSync(join(home, '.codex'))
    const own = '{"tokens":{"access_token":"own","refresh_token":"r","id_token":"a.b.c"}}\n'
    writeFileSync(join(home, '.codex', 'auth.json'), own)
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_1' }) })
    expect(file('.codex/auth.json.orca-saved')).toBe(own)
    // Rollover/clone: a new sandbox id, the old placeholder is recognised as ours and replaced.
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_2' }) })
    expect(JSON.parse(file('.codex/auth.json')!).tokens.access_token).toBe(codexPlaceholder({ id: 'sbx_2' }))
    expect(file('.codex/auth.json.orca-saved')).toBe(own)
    run({})
    expect(file('.codex/auth.json')).toBe(own)
    expect(file('.codex/auth.json.orca-saved')).toBeNull()
    expect(file('.codex/config.toml')).not.toContain('orca_chatgpt')
  })

  it('never overwrites a login already set aside, and recognises its own placeholder without the marker', () => {
    const { home, run, file } = scratch()
    mkdirSync(join(home, '.codex'))
    const saved = '{"tokens":{"access_token":"first"}}\n'
    const second = '{"tokens":{"access_token":"second"}}\n'
    writeFileSync(join(home, '.codex', 'auth.json.orca-saved'), saved)
    writeFileSync(join(home, '.codex', 'auth.json'), second)
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_1' }) })
    expect(file('.codex/auth.json.orca-saved')).toBe(saved)
    const aside = readdirSync(join(home, '.codex')).filter((name) => name.startsWith('auth.json.orca-saved.'))
    expect(aside.map((name) => file(`.codex/${name}`))).toEqual([second])
    // A run cut short before the marker: the placeholder is still Orca's, never set aside as a login.
    rmSync(join(home, '.codex', '.orca-account-placeholder'))
    run({ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_2' }) })
    expect(file('.codex/auth.json.orca-saved')).toBe(saved)
    run({})
    expect(file('.codex/auth.json')).toBe(saved)
  })

  it('leaves config.toml byte-identical across refreshes (no blank-line growth) and keeps user settings', () => {
    const { home, run, file } = scratch()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-x"\n\n[profiles.mine]\nmodel = "y"\n')
    for (const secrets of [{ ORCA_CODEX_AUTH_PLACEHOLDER: codexPlaceholder({ id: 'sbx_1' }) }, { OPENAI_BASE_URL: 'https://gw.example.com/v1' }, {}] as Record<string, string>[]) {
      run(secrets)
      const first = file('.codex/config.toml')
      run(secrets)
      run(secrets)
      expect(file('.codex/config.toml')).toBe(first)
      expect(first).toContain('model = "gpt-x"\n\n[profiles.mine]\nmodel = "y"\n')
    }
  })
})

// G9: ~/.claude.json pre-approves ANTHROPIC_API_KEY by its last 20 characters. Only an Orca placeholder's tail may be
// written; a real key (placeholders off) leaves nothing of itself on disk, and an older image's tail is scrubbed.
describe('orca-sandbox-env: Claude Code API-key approval (G9)', () => {
  const PLACEHOLDER = 'orca-ph-anthropic-api-key-sbx_0123456789abcdef'
  const REAL = 'sk-ant-api03-REALkey-fake-for-tests-0000-TAILTAILTAIL1234'
  const claude = (file: (path: string) => string | null) => JSON.parse(file('.claude.json') ?? '{}')

  it('a placeholder: its tail is approved', () => {
    const { run, file } = scratch()
    run({ ANTHROPIC_API_KEY: PLACEHOLDER })
    expect(claude(file).customApiKeyResponses.approved).toEqual([PLACEHOLDER.slice(-20)])
  })

  it('a real key: nothing from it is written, and a tail an older image wrote is removed', () => {
    const { home, run, file } = scratch()
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ customApiKeyResponses: { approved: [REAL.slice(-20), 'someone-elses-tail-x'], rejected: [REAL.slice(-20)] } })
    )
    run({ ANTHROPIC_API_KEY: REAL })
    const text = file('.claude.json')!
    expect(text).not.toContain(REAL.slice(-20))
    expect(text).not.toContain(REAL.slice(-8))
    expect(claude(file).customApiKeyResponses).toEqual({ approved: ['someone-elses-tail-x'], rejected: [] })
    // The rest of the first-run answers still apply.
    expect(claude(file).hasCompletedOnboarding).toBe(true)
  })

  it('no key: no approval entry at all (unchanged)', () => {
    const { run, file } = scratch()
    run({ FOO: 'bar' })
    expect(claude(file).customApiKeyResponses).toBeUndefined()
    expect(claude(file).hasCompletedOnboarding).toBe(true)
  })
})

describe('orca-sandbox-env: Claude signed in inside the workspace', () => {
  const claudeJson = (file: (path: string) => string | null) => JSON.parse(file('.claude.json') ?? '{}')

  it('with no login yet, leaves onboarding to Claude so it opens on its own sign-in screens; never a shell variable', () => {
    const { run, file, sessionEnv } = scratch()
    run({ ORCA_SIGN_IN_INSIDE: 'claude,codex', FOO: 'bar' })
    const c = claudeJson(file)
    expect(c.hasCompletedOnboarding).toBeUndefined()
    // The other first-run answers still apply.
    expect(c.bypassPermissionsModeAccepted).toBe(true)
    expect(sessionEnv()).not.toContain('ORCA_SIGN_IN_INSIDE')
  })

  it('clears a mark an earlier session made, and marks onboarding done once a login exists here', () => {
    const { home, run, file } = scratch()
    run({})
    expect(claudeJson(file).hasCompletedOnboarding).toBe(true)
    run({ ORCA_SIGN_IN_INSIDE: 'claude' })
    expect(claudeJson(file).hasCompletedOnboarding).toBeUndefined()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}')
    run({ ORCA_SIGN_IN_INSIDE: 'claude' })
    expect(claudeJson(file).hasCompletedOnboarding).toBe(true)
  })

  it('only Codex inside, or a malformed value, keeps Claude onboarding done', () => {
    const { run, file } = scratch()
    run({ ORCA_SIGN_IN_INSIDE: 'codex' })
    expect(claudeJson(file).hasCompletedOnboarding).toBe(true)
    run({ ORCA_SIGN_IN_INSIDE: 'claude;rm -rf /' })
    expect(claudeJson(file).hasCompletedOnboarding).toBe(true)
  })
})

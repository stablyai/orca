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
      env: { PATH: process.env.PATH, HOME: home, ORCA_SESSION_ENV_DIR: join(root, 'shm'), ORCA_SECRET_ENV: encoded, ORCA_ENV_GENERATION: String(generation++) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }
  const file = (path: string) => (existsSync(join(home, path)) ? readFileSync(join(home, path), 'utf8') : null)
  return { home, run, file, sessionEnv: () => readFileSync(join(root, 'shm', 'session.env'), 'utf8') }
}

describe('orca-sandbox-env: Codex via the Orca account', () => {
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

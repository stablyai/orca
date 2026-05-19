import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'

describe('prepareLocalCommitMessageAgentEnv (Claude)', () => {
  // Snapshot/restore the provider env keys the helper may strip — keeps the
  // test isolated from whatever the developer machine has set.
  const ENV_KEYS_TO_SNAPSHOT = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR'
  ] as const
  const snapshot: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_SNAPSHOT) {
      snapshot[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS_TO_SNAPSHOT) {
      const prior = snapshot[key]
      if (prior === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prior
      }
    }
  })

  it('uses applyEnvFromMaterialization when preparation.materialization is set (non-OAuth provider)', async () => {
    // Seed a stale provider key to prove it gets stripped.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-oauth-token'

    const result = await prepareLocalCommitMessageAgentEnv('claude', {
      prepareForClaudeLaunch: async () => ({
        configDir: '/tmp/claude',
        envPatch: {},
        stripAuthEnv: true,
        provenance: 'managed:api-key-account',
        materialization: {
          envPatch: {
            ANTHROPIC_API_KEY: 'sk-ant-test-1234'
          }
        }
      })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env).toBeDefined()
    expect(result.env!.ANTHROPIC_API_KEY).toBe('sk-ant-test-1234')
    // Stale provider env got stripped by the allowlist-replace path.
    expect(result.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('falls back to applyClaudeEnvPatch when preparation.materialization is undefined (OAuth)', async () => {
    const result = await prepareLocalCommitMessageAgentEnv('claude', {
      prepareForClaudeLaunch: async () => ({
        configDir: '/tmp/claude-oauth',
        envPatch: { CLAUDE_CONFIG_DIR: '/tmp/claude-oauth' },
        stripAuthEnv: true,
        provenance: 'managed:oauth-account'
      })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env).toBeDefined()
    expect(result.env!.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-oauth')
    // OAuth path does not inject ANTHROPIC_API_KEY.
    expect(result.env!.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

describe('prepareLocalCommitMessageAgentEnv', () => {
  const originalEnv = { ...process.env }
  const tempDirs: string[] = []

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-commit-env-'))
    tempDirs.push(dir)
    process.env.HOME = dir
    process.env.SHELL = '/bin/zsh'
    delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    return dir
  }

  it('hydrates OpenCode config dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.OPENCODE_CONFIG_DIR
    writeFileSync(join(home, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/company/opencode"\n')

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: join(home, 'company/opencode')
      })
    })
  })

  it('prefers the original OpenCode config root over inherited PTY overlays', async () => {
    process.env.OPENCODE_CONFIG_DIR = '/tmp/orca-opencode-overlay'
    process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = '/Users/tester/company/opencode'

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: '/Users/tester/company/opencode'
      })
    })
  })

  it('hydrates Pi agent dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.PI_CODING_AGENT_DIR
    writeFileSync(join(home, '.zshrc'), 'export PI_CODING_AGENT_DIR="$HOME/.config/pi-agent"\n')

    const result = await prepareLocalCommitMessageAgentEnv('pi', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: join(home, '.config/pi-agent')
      })
    })
  })

  it('prefers the original Pi agent root over inherited PTY overlays', async () => {
    process.env.PI_CODING_AGENT_DIR = '/tmp/orca-pi-overlay'
    process.env.ORCA_PI_SOURCE_AGENT_DIR = '/Users/tester/.pi/agent'

    const result = await prepareLocalCommitMessageAgentEnv('pi', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: '/Users/tester/.pi/agent'
      })
    })
  })

  it('does not synthesize env for agents without shell-scoped auth or config roots', async () => {
    makeHome()

    await expect(prepareLocalCommitMessageAgentEnv('cursor', undefined)).resolves.toEqual({
      ok: true
    })
  })

  it('falls back to inherited env when managed account resolvers are unavailable', async () => {
    await expect(prepareLocalCommitMessageAgentEnv('codex', undefined)).resolves.toEqual({
      ok: true
    })
    await expect(prepareLocalCommitMessageAgentEnv('claude', undefined)).resolves.toEqual({
      ok: true
    })
  })
})

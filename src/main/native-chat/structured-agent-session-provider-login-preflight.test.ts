import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  probeStructuredAgentSessionProviderLogin,
  resolveStructuredCodexPreflightHomePath,
  resolveStructuredClaudeAccountHomePath
} from './structured-agent-session-provider-login-preflight'

const homes: string[] = []

function providerHome(files: Record<string, string> = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'structured-login-'))
  homes.push(path)
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(path, name), contents, 'utf-8')
  }
  return path
}

afterEach(() => {
  for (const path of homes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('probeStructuredAgentSessionProviderLogin', () => {
  it('answers missing for an account home with no credential', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'claude',
        accountHomePath: providerHome(),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('missing')
  })

  it('answers missing when the account home was never created', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'codex',
        accountHomePath: join(providerHome(), 'never-created'),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('missing')
  })

  it('answers present for a stored credential file', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'claude',
        accountHomePath: providerHome({ '.credentials.json': '{"claudeAiOauth":{}}' }),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('present')
  })

  it('answers present for Codex auth.json', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'codex',
        accountHomePath: providerHome({ 'auth.json': '{"tokens":{}}' }),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('present')
  })

  it('answers present for an environment credential with no account home', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'claude',
        accountHomePath: join(providerHome(), 'never-created'),
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        platform: 'linux'
      })
    ).resolves.toBe('present')
  })

  it('answers present when settings delegate auth to a helper command', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'claude',
        accountHomePath: providerHome({ 'settings.json': '{"apiKeyHelper":"/usr/bin/token"}' }),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('present')
  })

  /** Loss of evidence is not evidence of absence: these must never read as `missing`. */
  it('answers unverifiable when the account home is not a directory', async () => {
    const home = providerHome({ blocked: 'not a directory' })
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'codex',
        accountHomePath: join(home, 'blocked'),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('unverifiable')
  })

  it('answers unverifiable when the settings will not parse', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'claude',
        accountHomePath: providerHome({ 'settings.json': '{ not json' }),
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('unverifiable')
  })

  it('answers unverifiable for Claude on macOS, where the login may be in the keychain', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'claude',
        accountHomePath: providerHome(),
        env: {},
        platform: 'darwin'
      })
    ).resolves.toBe('unverifiable')
  })

  it('answers unverifiable when the launch home is only knowable by preparing it', async () => {
    await expect(
      probeStructuredAgentSessionProviderLogin({
        agent: 'codex',
        accountHomePath: null,
        env: {},
        platform: 'linux'
      })
    ).resolves.toBe('unverifiable')
  })
})

describe('structured account home resolution', () => {
  it('prefers the launch environment over the managed Claude directory', () => {
    expect(
      resolveStructuredClaudeAccountHomePath({
        launchEnv: { CLAUDE_CONFIG_DIR: '/from/env' },
        managedConfigDir: '/from/accounts'
      })
    ).toBe('/from/env')
  })

  it('falls back to the managed Claude directory', () => {
    expect(
      resolveStructuredClaudeAccountHomePath({
        launchEnv: {},
        managedConfigDir: '/from/accounts'
      })
    ).toBe('/from/accounts')
  })

  /** A prepared home is materialized by the launch itself, so a read-only probe cannot see it. */
  it('declines to name a Codex home that only a launch would prepare', () => {
    expect(
      resolveStructuredCodexPreflightHomePath({
        launchEnv: { CODEX_HOME: '/from/env' },
        homeIsPreparedAtLaunch: true
      })
    ).toBeNull()
  })

  it('uses the configured Codex home when nothing prepares one', () => {
    expect(
      resolveStructuredCodexPreflightHomePath({
        launchEnv: { CODEX_HOME: '/from/env' },
        homeIsPreparedAtLaunch: false
      })
    ).toBe('/from/env')
  })
})

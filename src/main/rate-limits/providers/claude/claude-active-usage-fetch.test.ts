import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { PROXY_ENVIRONMENT_KEYS } from '../../../../shared/network/network-proxy'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'

vi.mock('./claude-oauth-credentials', () => ({
  readClaudeOAuthCredentials: async () => ({ token: 'token', source: 'credentials-file' }),
  resolveClaudeOAuthCredentialReadOptions: () => undefined
}))

const managed = vi.hoisted(() => ({ file: '' }))
vi.mock('../../../claude/configuration/claude-managed-settings-file', () => ({
  claudeManagedSettingsFile: () => managed.file
}))

let configDir: string
const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function writeSettings(path: string, env: Record<string, string>): void {
  writeFileSync(path, JSON.stringify({ env }))
}

beforeEach(() => {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    vi.stubEnv(key, '')
  }
  configDir = mkdtempSync(join(tmpdir(), 'orca-claude-usage-proxy-'))
  managed.file = join(configDir, 'managed-settings.json')
  writeSettings(join(configDir, 'settings.json'), {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,.internal'
  })
})

afterEach(() => {
  setPlatform(realPlatform)
  vi.unstubAllEnvs()
  setMainHttpClient(null)
  rmSync(configDir, { recursive: true, force: true })
})

async function routedProxies(
  options: Omit<ClaudeRateLimitFetchOptions, 'authPreparation'> = {},
  { runtime, proxyDown }: { runtime?: 'wsl'; proxyDown?: boolean } = {}
): Promise<unknown[]> {
  const routed: unknown[] = []
  const response = (): Response => Response.json({ five_hour: { utilization: 12 } })
  setMainHttpClient({
    fetch: async () => response(),
    fetchThroughProxy: async (proxy) => {
      routed.push(proxy)
      if (proxyDown) {
        throw new TypeError('net::ERR_PROXY_CONNECTION_FAILED')
      }
      return response()
    },
    proxySession: () => null
  })
  const usage = await fetchActiveClaudeRateLimits({
    ...options,
    authPreparation: { configDir, envPatch: {}, provenance: 'system', runtime }
  })
  expect(usage.status).toBe('ok')
  return routed
}

const orcaProxy = { networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:8080' } }

it("routes the usage request through the proxy in the account's settings.json", async () => {
  expect(await routedProxies()).toEqual([
    { httpProxyUrl: 'http://127.0.0.1:7890', httpProxyBypassRules: 'localhost;.internal' }
  ])
  // Claude splits NO_PROXY on whitespace too, so the token must not reach an exempted proxy.
  writeSettings(join(configDir, 'settings.json'), {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost api.anthropic.com'
  })
  expect(await routedProxies()).toEqual([
    { httpProxyUrl: 'http://127.0.0.1:7890', httpProxyBypassRules: 'localhost;api.anthropic.com' }
  ])
})

it('lets the managed settings proxy win, as it does for Claude', async () => {
  writeSettings(managed.file, { HTTPS_PROXY: 'http://10.0.0.1:3128' })
  expect(await routedProxies()).toEqual([
    { httpProxyUrl: 'http://10.0.0.1:3128', httpProxyBypassRules: 'localhost;.internal' }
  ])
})

it('follows the proxy Claude picks over the env Orca launches it with', async () => {
  setPlatform('linux')
  // Orca sets both spellings and Claude reads https_proxy first, so an uppercase-only override loses.
  writeSettings(join(configDir, 'settings.json'), { HTTPS_PROXY: 'http://127.0.0.1:7890' })
  expect(await routedProxies(orcaProxy)).toEqual([])
  writeSettings(join(configDir, 'settings.json'), { https_proxy: 'http://127.0.0.1:7890' })
  expect(await routedProxies(orcaProxy)).toEqual([
    { httpProxyUrl: 'http://127.0.0.1:7890', httpProxyBypassRules: '' }
  ])
  // Claude ignores ALL_PROXY.
  writeSettings(join(configDir, 'settings.json'), { ALL_PROXY: 'http://127.0.0.1:7890' })
  expect(await routedProxies()).toEqual([])
})

it("lets an uppercase settings proxy replace Orca's on Windows, where env names ignore case", async () => {
  setPlatform('win32')
  writeSettings(join(configDir, 'settings.json'), { HTTPS_PROXY: 'http://127.0.0.1:7890' })
  expect(await routedProxies(orcaProxy)).toEqual([
    { httpProxyUrl: 'http://127.0.0.1:7890', httpProxyBypassRules: '' }
  ])
})

// Failed proxies are remembered per URL, so these tests use their own.
it('falls back to the app-wide path when the settings proxy is down', async () => {
  writeSettings(join(configDir, 'settings.json'), { HTTPS_PROXY: 'http://127.0.0.1:7891' })
  expect(await routedProxies({}, { proxyDown: true })).toHaveLength(1)
})

it('skips a settings proxy that just failed', async () => {
  writeSettings(join(configDir, 'settings.json'), { HTTPS_PROXY: 'http://127.0.0.1:7892' })
  expect(await routedProxies({}, { proxyDown: true })).toHaveLength(1)
  expect(await routedProxies()).toEqual([])
})

it('keeps WSL accounts on the app-wide path', async () => {
  expect(await routedProxies({}, { runtime: 'wsl' })).toEqual([])
})

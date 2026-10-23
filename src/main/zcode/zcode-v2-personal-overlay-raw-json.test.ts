import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchZcodeRateLimits } from '../rate-limits/zcode-usage-fetcher'
import { readZcodeUsageCredentials } from '../rate-limits/zcode-usage-credentials'
import { readZcodeV2PlanCredential, type ZcodeCredentialHost } from './zcode-v2-plan-credentials'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>())
}))

let home: string
let host: ZcodeCredentialHost
let configPath: string
let vaultPath: string

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'orca-zcode-raw-json-'))
  fs.cpSync(
    join(import.meta.dirname, 'fixtures', 'v2-upstream', 'bigmodel'),
    join(home, '.zcode', 'v2'),
    {
      recursive: true
    }
  )
  configPath = join(home, '.zcode', 'v2', 'provider_config.json')
  vaultPath = join(home, '.zcode', 'v2', 'credentials.json')
  host = {
    home,
    platform: 'linux',
    username: 'synthetic-user',
    env: { ZCODE_DATA_BASE_DIR: home, ZCODE_CREDENTIAL_SECRET: 'synthetic-secret' }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12 }]
            }
          })
        )
    )
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fs.rmSync(home, { recursive: true, force: true })
})

function installRawLeaf(group: string, rawLeaf: string): void {
  const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const selection = document.config.defaultModelSelection
  const rule = {
    providerId: selection.providerId,
    ...(group === 'providerRules' ? {} : { modelId: selection.modelId }),
    config: JSON.parse(rawLeaf)
  }
  const rules =
    group === 'providerRules'
      ? document.config.providerConfigRules
      : document.config.modelConfigRules
  rules[group] = [rule]
  fs.writeFileSync(configPath, JSON.stringify(document))
}

const cases = ['providerRules', 'providerModelRules', 'manualProviderModelRules'].flatMap((group) =>
  ['__proto__', 'constructor', 'prototype'].map((key) => ({ group, key }))
)

describe('raw persisted personal rule keys', () => {
  it.each(cases)(
    'refuses $group with raw $key before vault access or quota',
    async ({ group, key }) => {
      installRawLeaf(group, `{"${key}":{"syntheticUnknownLeaf":true}}`)
      const configBefore = fs.readFileSync(configPath)
      const vaultBefore = fs.readFileSync(vaultPath)
      const stat = vi.spyOn(fs, 'statSync')
      const lstat = vi.spyOn(fs, 'lstatSync')
      const open = vi.spyOn(fs, 'openSync')
      const read = vi.spyOn(fs, 'readFileSync')

      expect(readZcodeV2PlanCredential(host).status).toBe('unavailable')
      expect(readZcodeUsageCredentials({ credentialHost: host }).status).toBe('unavailable')
      expect((await fetchZcodeRateLimits({ credentialHost: host })).status).toBe('unavailable')
      expect(fetch).not.toHaveBeenCalled()
      for (const calls of [stat.mock.calls, lstat.mock.calls, open.mock.calls, read.mock.calls]) {
        expect(calls.filter(([path]) => path === vaultPath)).toHaveLength(0)
      }
      expect(fs.readFileSync(configPath)).toEqual(configBefore)
      expect(fs.readFileSync(vaultPath)).toEqual(vaultBefore)

      const saved = await fetchZcodeRateLimits({
        credentialHost: host,
        planCredential: {
          apiKey: 'synthetic-orca-key',
          baseUrl: 'https://api.z.ai'
        }
      })
      expect(saved.status).toBe('ok')
      expect(saved.usageMetadata?.credentialSource).toBe('orca-plan')
      expect(JSON.stringify(saved)).not.toContain('synthetic-orca-key')
    }
  )

  it.each(['providerRules', 'providerModelRules'])('accepts a known empty %s config', (group) => {
    installRawLeaf(group, '{}')
    expect(readZcodeV2PlanCredential(host)).toMatchObject({
      status: 'ok',
      baseUrl: 'https://open.bigmodel.cn'
    })
  })

  it.each(['null', '[]', '42'])('rejects a malformed raw config %s', (raw) => {
    installRawLeaf('providerRules', raw)
    expect(readZcodeV2PlanCredential(host).status).toBe('error')
  })
})

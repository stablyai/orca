import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { buildSync } from 'esbuild'
import { runProcess } from '../../shared/child-process/run-process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readZcodeV2PlanCredential, type ZcodeCredentialHost } from './zcode-v2-plan-credentials'
import { readZcodeUsageCredentials } from '../rate-limits/zcode-usage-credentials'
import { fetchZcodeRateLimits } from '../rate-limits/zcode-usage-fetcher'

let dir: string
let host: ZcodeCredentialHost
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'v2-upstream')
function install(name = 'zai') {
  cpSync(join(fixtureRoot, name), join(dir, '.zcode', 'v2'), { recursive: true })
}
function legacy() {
  mkdirSync(join(dir, '.zcode', 'cli'), { recursive: true })
  writeFileSync(
    join(dir, '.zcode', 'cli', 'config.json'),
    JSON.stringify({
      model: 'legacy/GLM',
      provider: {
        legacy: { options: { apiKey: 'synthetic-legacy-key', baseURL: 'https://open.bigmodel.cn' } }
      }
    })
  )
}
function quota() {
  return new Response(
    JSON.stringify({
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12 }] }
    })
  )
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-zcode-v2-'))
  host = {
    home: dir,
    platform: 'linux',
    username: 'synthetic-user',
    env: { ZCODE_DATA_BASE_DIR: dir, ZCODE_CREDENTIAL_SECRET: 'synthetic-secret' }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => quota())
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('upstream-written ZCode v2 stores', () => {
  it.each(['zai', 'bigmodel'])(
    'reads selected %s plan, exact encoded identity key and site without writing',
    async (name) => {
      install(name)
      const before = readFileSync(join(dir, '.zcode', 'v2', 'credentials.json'))
      expect(readZcodeV2PlanCredential(host)).toMatchObject({
        status: 'ok',
        apiKey: `synthetic-${name}-key`,
        baseUrl: name === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
      })
      const result = await fetchZcodeRateLimits({ credentialHost: host })
      expect(result.status).toBe('ok')
      const call = vi.mocked(fetch).mock.calls[0]
      expect(String(call[0])).toContain(name === 'zai' ? 'api.z.ai' : 'open.bigmodel.cn')
      expect(new Headers(call[1]?.headers).get('Authorization')).toBe(`synthetic-${name}-key`)
      expect(JSON.stringify(result)).not.toContain(`synthetic-${name}-key`)
      expect(JSON.stringify(result)).not.toContain('synthetic account')
      expect(readFileSync(join(dir, '.zcode', 'v2', 'credentials.json'))).toEqual(before)
      expect(readdirSync(join(dir, '.zcode', 'v2')).sort()).toEqual([
        'credentials.json',
        'provider_config.json'
      ])
    }
  )

  it('prefers migrated credentials over a stale legacy account', () => {
    legacy()
    install()
    const result = readZcodeUsageCredentials({ credentialHost: host })
    expect(result).toMatchObject({ status: 'ok', credentials: { apiKey: 'synthetic-zai-key' } })
  })

  it('keeps legacy support when no personal v2 file exists', () => {
    legacy()
    expect(readZcodeUsageCredentials({ credentialHost: host })).toMatchObject({
      status: 'ok',
      credentials: { apiKey: 'synthetic-legacy-key' }
    })
  })

  it.each([
    'unsupported',
    'missing-selection',
    'future-schema',
    'invalid-json',
    'bad-ciphertext',
    'missing-key'
  ])('never substitutes legacy credentials for %s v2 state', async (kind) => {
    legacy()
    install()
    const path = join(dir, '.zcode', 'v2', 'provider_config.json')
    if (kind === 'unsupported') {
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          config: {
            defaultModelSelection: { providerId: 'account:zai-team-coding-plan', modelId: 'GLM' }
          }
        })
      )
    }
    if (kind === 'missing-selection') {
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, config: {} }))
    }
    if (kind === 'future-schema') {
      writeFileSync(path, JSON.stringify({ schemaVersion: 2, config: {} }))
    }
    if (kind === 'invalid-json') {
      writeFileSync(path, 'not-json')
    }
    if (kind === 'bad-ciphertext') {
      writeFileSync(
        join(dir, '.zcode', 'v2', 'credentials.json'),
        JSON.stringify({
          'account-provider:account:zai-individual-coding-plan:identity': 'enc:v1:broken'
        })
      )
    }
    if (kind === 'missing-key') {
      writeFileSync(join(dir, '.zcode', 'v2', 'credentials.json'), '{}')
    }
    const result = await fetchZcodeRateLimits({ credentialHost: host })
    expect(['unavailable', 'error']).toContain(result.status)
    expect(result.session).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('synthetic-legacy-key')
  })

  it('honors custom secret and does not decrypt another host secret', () => {
    install()
    expect(readZcodeV2PlanCredential(host).status).toBe('ok')
    expect(
      readZcodeV2PlanCredential({
        ...host,
        env: { ...host.env, ZCODE_CREDENTIAL_SECRET: 'wrong-secret' }
      })
    ).toEqual({ status: 'error' })
  })

  it('honors the upstream personal config override independently of the credential directory', () => {
    install()
    const selected = join(dir, 'selected.json')
    cpSync(join(dir, '.zcode', 'v2', 'provider_config.json'), selected)
    writeFileSync(join(dir, '.zcode', 'v2', 'provider_config.json'), 'invalid-default')
    expect(
      readZcodeV2PlanCredential({
        ...host,
        env: { ...host.env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '~/selected.json' }
      })
    ).toMatchObject({ status: 'ok', configPath: selected })
  })

  it('accepts upstream plaintext compatibility and rejects header injection without a request', async () => {
    install()
    const path = join(dir, '.zcode', 'v2', 'credentials.json')
    const identityKey = 'account-provider:account:zai-individual-coding-plan:identity'
    const apiKey =
      'account-provider:coding-plan:account:zai-individual-coding-plan:account:synthetic:api-key'
    writeFileSync(
      path,
      JSON.stringify({ [identityKey]: 'synthetic', [apiKey]: 'synthetic-plain-key' })
    )
    expect(readZcodeV2PlanCredential(host)).toMatchObject({
      status: 'ok',
      apiKey: 'synthetic-plain-key'
    })
    writeFileSync(
      path,
      JSON.stringify({ [identityKey]: 'synthetic', [apiKey]: 'key\r\nInjected: value' })
    )
    expect((await fetchZcodeRateLimits({ credentialHost: host })).status).toBe('error')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses execution-host identity, not data-directory identity, for the fallback cipher', () => {
    install('fallback-host')
    const fallback = { ...host, home: '/synthetic/home', env: { ZCODE_DATA_BASE_DIR: dir } }
    expect(readZcodeV2PlanCredential(fallback)).toMatchObject({
      status: 'ok',
      apiKey: 'synthetic-fallback-host-key'
    })
    for (const changed of [
      { home: '/other/home' },
      { platform: 'win32' },
      { username: 'other-user' }
    ]) {
      expect(readZcodeV2PlanCredential({ ...fallback, ...changed })).toEqual({ status: 'error' })
    }
  })

  it('does not borrow credentials from another execution host', () => {
    install()
    const other = join(dir, 'other-host')
    mkdirSync(other)
    expect(
      readZcodeV2PlanCredential({
        ...host,
        home: other,
        env: { ZCODE_DATA_BASE_DIR: other, ZCODE_CREDENTIAL_SECRET: 'synthetic-secret' }
      })
    ).toEqual({ status: 'absent' })
  })

  it('preserves the protected Orca key priority even if v2 is corrupt', async () => {
    install()
    writeFileSync(join(dir, '.zcode', 'v2', 'credentials.json'), 'broken')
    const result = await fetchZcodeRateLimits({
      credentialHost: host,
      planCredential: { apiKey: 'synthetic-orca-key', baseUrl: 'https://open.bigmodel.cn' }
    })
    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.credentialSource).toBe('orca-plan')
  })

  it.each(['site', 'account', 'corrupt', 'network-error'])(
    'drops an in-flight quota when %s changes',
    async (change) => {
      install()
      vi.mocked(fetch).mockImplementationOnce(async () => {
        if (change === 'site') {
          install('bigmodel')
        } else if (change === 'account') {
          install('zai-other')
        } else {
          writeFileSync(join(dir, '.zcode', 'v2', 'credentials.json'), 'broken')
        }
        if (change === 'network-error') {
          throw new Error('Synthetic transport failure')
        }
        return quota()
      })
      const result = await fetchZcodeRateLimits({ credentialHost: host })
      expect(result.status).toBe('unavailable')
      expect(result.session).toBeNull()
    }
  )
})

describe('external v2 file boundaries', () => {
  it.each(['provider_config.json', 'credentials.json'])(
    'refuses oversized %s without legacy fallback',
    (name) => {
      install()
      legacy()
      const path = join(dir, '.zcode', 'v2', name)
      const record = JSON.parse(readFileSync(path, 'utf8'))
      record['unrelated'] = 'x'.repeat(4 * 1024 * 1024)
      writeFileSync(path, JSON.stringify(record))
      expect(readZcodeUsageCredentials({ credentialHost: host }).status).toBe('error')
    }
  )

  it.each(['provider_config.json', 'credentials.json'])('refuses a directory at %s', (name) => {
    install()
    const path = join(dir, '.zcode', 'v2', name)
    rmSync(path)
    mkdirSync(path)
    expect(readZcodeV2PlanCredential(host).status).toBe('error')
  })

  it.skipIf(process.platform === 'win32').each([
    { name: 'provider_config.json', replace: false },
    { name: 'credentials.json', replace: false },
    { name: 'provider_config.json', replace: true },
    { name: 'credentials.json', replace: true }
  ])(
    'settles FIFO $name with replacement $replace in a timeout-fenced child',
    async ({ name, replace }) => {
      install()
      const path = join(dir, '.zcode', 'v2', name)
      const fifoPath = replace ? join(dir, 'replacement.fifo') : path
      if (!replace) {
        rmSync(path)
      }
      expect((await runProcess({ program: 'mkfifo', args: [fifoPath] })).code).toBe(0)
      const bundle = buildSync({
        entryPoints: [join(import.meta.dirname, 'zcode-v2-plan-credentials.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false
      }).outputFiles[0]!.text
      const setup = replace
        ? `const fs=require('node:fs'),originalStat=fs.statSync;fs.statSync=(path,...args)=>{const evidence=originalStat(path,...args);if(path===${JSON.stringify(path)})fs.renameSync(${JSON.stringify(fifoPath)},path);return evidence};`
        : ''
      const script = join(dir, 'read.cjs')
      writeFileSync(
        script,
        `${bundle}\n${setup}\nconsole.log(module.exports.readZcodeV2PlanCredential(${JSON.stringify(host)}).status)`
      )
      const result = await runProcess({
        program: process.execPath,
        args: [script],
        timeoutMs: 2000
      })
      expect(result.timedOut).toBe(false)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('error')
    }
  )

  it.each([
    { options: { reasoningLevel: 42 } },
    { options: { reasoningLevel: '' } },
    { options: { reasoningLevel: '  ' } },
    { options: { extra: true } },
    { extra: true },
    { options: null }
  ])('rejects upstream-invalid selection %j without legacy fallback', (changed) => {
    install()
    legacy()
    const path = join(dir, '.zcode', 'v2', 'provider_config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    Object.assign(config.config.defaultModelSelection, changed)
    writeFileSync(path, JSON.stringify(config))
    expect(readZcodeUsageCredentials({ credentialHost: host }).status).toBe('error')
  })

  it('accepts a valid optional reasoning level', () => {
    install()
    const path = join(dir, '.zcode', 'v2', 'provider_config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    config.config.defaultModelSelection.options = { reasoningLevel: ' high ' }
    writeFileSync(path, JSON.stringify(config))
    expect(readZcodeV2PlanCredential(host).status).toBe('ok')
  })

  it.each([
    { providerConfigRules: null },
    { providerConfigRules: { providerRules: 42 } },
    { providerConfigRules: { providerRules: [], unknown: true } },
    { modelConfigRules: null },
    { modelConfigRules: { providerModelRules: 42, manualProviderModelRules: [] } },
    { modelConfigRules: { providerModelRules: [], manualProviderModelRules: [null] } },
    { modelConfigRules: { providerModelRules: [{}], manualProviderModelRules: [] } }
  ])('rejects upstream-invalid rule containers %j without legacy fallback', (changed) => {
    install()
    legacy()
    const path = join(dir, '.zcode', 'v2', 'provider_config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    Object.assign(config.config, changed)
    writeFileSync(path, JSON.stringify(config))
    expect(readZcodeUsageCredentials({ credentialHost: host }).status).toBe('error')
  })

  it('accepts a valid selected-provider empty personal rule and smart model rule', () => {
    install('bigmodel')
    const path = join(dir, '.zcode', 'v2', 'provider_config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    const selection = config.config.defaultModelSelection
    config.config.providerConfigRules.providerRules = [
      { providerId: selection.providerId, config: {} }
    ]
    config.config.modelConfigRules.providerModelRules = [{ ...selection, config: {} }]
    writeFileSync(path, JSON.stringify(config))
    expect(readZcodeV2PlanCredential(host)).toMatchObject({
      status: 'ok',
      baseUrl: 'https://open.bigmodel.cn'
    })
  })

  it.each([
    { access: { type: 'api-key', apiKey: 'synthetic-personal-key' } },
    { access: null },
    { api: { type: 'bad-api-type', baseUrl: 'invalid-url' } },
    { api: { baseUrl: 'https://valid.example' } },
    { visibility: 'hidden' }
  ])(
    'refuses unvalidated provider config %j without reading the vault or querying quota',
    async (personal) => {
      install('bigmodel')
      legacy()
      const path = join(dir, '.zcode', 'v2', 'provider_config.json')
      const config = JSON.parse(readFileSync(path, 'utf8'))
      config.config.providerConfigRules.providerRules = [
        { providerId: config.config.defaultModelSelection.providerId, config: personal }
      ]
      writeFileSync(path, JSON.stringify(config))
      rmSync(join(dir, '.zcode', 'v2', 'credentials.json'))
      expect(readZcodeUsageCredentials({ credentialHost: host }).status).toBe('unavailable')
      expect((await fetchZcodeRateLimits({ credentialHost: host })).status).toBe('unavailable')
      expect(fetch).not.toHaveBeenCalled()
      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(config))
      expect(
        (
          await fetchZcodeRateLimits({
            credentialHost: host,
            planCredential: {
              apiKey: 'synthetic-orca-key',
              baseUrl: 'https://api.z.ai'
            }
          })
        ).status
      ).toBe('ok')
    }
  )

  it.each(['duplicate-provider', 'malformed-model', 'valid-unsupported-model', 'manual-model'])(
    'cannot establish selected credentials from %s rules',
    (kind) => {
      install('bigmodel')
      legacy()
      const path = join(dir, '.zcode', 'v2', 'provider_config.json')
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const selection = config.config.defaultModelSelection
      if (kind === 'duplicate-provider') {
        config.config.providerConfigRules.providerRules = Array.from({ length: 2 }, () => ({
          providerId: selection.providerId,
          config: {}
        }))
      } else {
        const group = kind === 'manual-model' ? 'manualProviderModelRules' : 'providerModelRules'
        config.config.modelConfigRules[group] = [
          {
            ...selection,
            config:
              kind === 'manual-model'
                ? {}
                : {
                    optionSpecs: {
                      reasoningLevel: { values: kind === 'malformed-model' ? 42 : ['high'] }
                    }
                  }
          }
        ]
      }
      writeFileSync(path, JSON.stringify(config))
      expect(readZcodeUsageCredentials({ credentialHost: host }).status).toBe(
        kind === 'duplicate-provider' ? 'error' : 'unavailable'
      )
    }
  )
})

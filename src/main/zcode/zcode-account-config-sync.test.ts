import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildZcodeAccountConfigPush,
  findZcodeBuiltinProviderConfigFile,
  resolveZcodeAccountConfigPaths,
  syncZcodeAccountConfig
} from './zcode-account-config-sync'

const BUILT_IN = {
  schemaVersion: 1,
  revision: 33,
  config: {
    providerConfigRules: {
      templateRules: [],
      providerRules: [
        {
          providerId: 'account:bigmodel-individual-coding-plan',
          config: {
            group: 'bigmodel-family',
            access: {
              type: 'zhipu-account',
              accountType: 'bigmodel',
              mode: 'individual-coding-plan'
            },
            api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash']
          }
        },
        {
          providerId: 'account:bigmodel-team-coding-plan',
          config: {
            group: 'bigmodel-family',
            access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'team-coding-plan' },
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash']
          }
        },
        {
          providerId: 'account:bigmodel-start-plan',
          config: {
            group: 'bigmodel-family',
            access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'start-plan' },
            builtinModelIds: ['GLM-5.3-Flash']
          }
        },
        {
          // Non-account (personal) rules never enter the push.
          providerId: 'openai',
          config: { group: 'standard-personal', builtinModelIds: ['gpt-6-astra'] }
        }
      ]
    }
  }
}

const CREDENTIALS = {
  'oauth:bigmodel:access_token': 'redacted',
  'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:16581759469279020:api-key':
    'redacted',
  'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:16581759469279020:api-key':
    'redacted'
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zcode-account-config-'))
  roots.push(root)
  return root
}

describe('zcode account config push', () => {
  it('builds membership-and-entitlement facts from the built-in catalog and credential keys', () => {
    const root = makeRoot()
    const builtInPath = join(root, 'zcode-builtin.json')
    const credentialsPath = join(root, 'credentials.json')
    const settingsPath = join(root, 'setting.json')
    writeFileSync(builtInPath, JSON.stringify(BUILT_IN))
    writeFileSync(credentialsPath, JSON.stringify(CREDENTIALS))
    writeFileSync(
      settingsPath,
      JSON.stringify({
        providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } }
      })
    )

    const push = buildZcodeAccountConfigPush({ builtInPath, credentialsPath, settingsPath })
    expect(push).not.toBeNull()
    expect(push?.revision).toBe('1')
    // The CLI's Registry only accepts the exact revision string its own config source
    // mints: `zcode-builtin:<release>:<sha256 of the active file's absolute path>`.
    expect(push?.basedOnZCodeBuiltinRevision).toBe(
      `zcode-builtin:33:${createHash('sha256').update(resolve(builtInPath)).digest('hex')}`
    )
    // Only the zhipu-account instances enter the push; the personal openai rule does not.
    expect(Object.keys(push?.providers ?? {}).sort()).toEqual([
      'account:bigmodel-individual-coding-plan',
      'account:bigmodel-start-plan',
      'account:bigmodel-team-coding-plan'
    ])
    expect(push?.providers['account:bigmodel-individual-coding-plan']).toEqual({
      builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
      access: { type: 'zhipu-account', entitled: true }
    })
    // The start plan holds no credential key, so it rides unentitled and unstated.
    expect(push?.providers['account:bigmodel-start-plan']?.access).toEqual({
      type: 'zhipu-account',
      entitled: false
    })
    expect(push?.states).toEqual({
      'account:bigmodel-individual-coding-plan': {
        entitled: true,
        availability: 'available',
        current: true
      },
      'account:bigmodel-team-coding-plan': {
        entitled: true,
        availability: 'available',
        current: false
      },
      'account:bigmodel-start-plan': {
        entitled: false,
        availability: 'unknown',
        current: false
      }
    })
  })

  it('returns null without a built-in file, a revision, or any zhipu-account instance', () => {
    const root = makeRoot()
    const credentialsPath = join(root, 'credentials.json')
    writeFileSync(credentialsPath, JSON.stringify(CREDENTIALS))

    expect(buildZcodeAccountConfigPush({ builtInPath: null, credentialsPath })).toBeNull()

    const noRevisionPath = join(root, 'no-revision.json')
    writeFileSync(noRevisionPath, JSON.stringify({ schemaVersion: 1, config: BUILT_IN.config }))
    expect(buildZcodeAccountConfigPush({ builtInPath: noRevisionPath, credentialsPath })).toBeNull()

    const noAccountsPath = join(root, 'no-accounts.json')
    writeFileSync(
      noAccountsPath,
      JSON.stringify({
        revision: 1,
        config: { providerConfigRules: { templateRules: [], providerRules: [] } }
      })
    )
    expect(buildZcodeAccountConfigPush({ builtInPath: noAccountsPath, credentialsPath })).toBeNull()
  })

  it('locates the newest built-in cache file when the launch env carries no path', () => {
    const root = makeRoot()
    const newer = join(
      root,
      '.zcode',
      'v2',
      'runtime',
      'provider',
      'linux-x86_64',
      '3.16.2',
      'endpoint-a'
    )
    const older = join(
      root,
      '.zcode',
      'v2',
      'runtime',
      'provider',
      'linux-x86_64',
      '3.16.1',
      'endpoint-b'
    )
    for (const [dir, offset] of [
      [newer, 2_000],
      [older, 1_000]
    ] as const) {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'zcode-builtin.json')
      writeFileSync(file, JSON.stringify(BUILT_IN))
      utimesSync(file, new Date(1_792_800_000_000 + offset), new Date(1_792_800_000_000 + offset))
    }
    expect(findZcodeBuiltinProviderConfigFile(root)).toBe(join(newer, 'zcode-builtin.json'))
    expect(
      resolveZcodeAccountConfigPaths({
        launchEnv: { ZCODE_DATA_BASE_DIR: root },
        cwd: root
      }).builtInPath
    ).toBe(join(newer, 'zcode-builtin.json'))
  })

  it('prefers the launch env path and derives the credential path from the data base', () => {
    const root = makeRoot()
    const paths = resolveZcodeAccountConfigPaths({
      launchEnv: {
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(root, 'explicit.json')
      },
      cwd: root
    })
    expect(paths.builtInPath).toBe(join(root, 'explicit.json'))
    expect(paths.credentialsPath).toBe(join(root, '.zcode', 'v2', 'credentials.json'))
  })

  it.each(['provider/updateAccountConfig', 'provider/refreshRegistry'])(
    'falls back when %s rejects',
    async (failedMethod) => {
      const root = makeRoot()
      const builtInPath = join(root, 'zcode-builtin.json')
      const credentialsPath = join(root, '.zcode', 'v2', 'credentials.json')
      mkdirSync(join(root, '.zcode', 'v2'), { recursive: true })
      writeFileSync(builtInPath, JSON.stringify(BUILT_IN))
      writeFileSync(credentialsPath, JSON.stringify(CREDENTIALS))
      const request = vi.fn(async (method: string) => {
        if (method === failedMethod) {
          throw new Error('unavailable')
        }
      })

      await expect(
        syncZcodeAccountConfig(
          { request },
          {
            ZCODE_DATA_BASE_DIR: root,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtInPath
          }
        )
      ).resolves.toBe(false)
    }
  )
})

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { signAdhocMacApp } from './sign-adhoc-mac-app.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const { resolveFunction } = appBuilderRequire('app-builder-lib/out/util/resolve')

it('preserves file-specific signing policy and retries with fresh options', async () => {
  const calls = []
  const failure = new Error('timestamp service unavailable')
  const options = {
    app: '/fixture/Orca.app',
    platform: 'darwin',
    type: 'distribution',
    identity: 'SIGNING_IDENTITY',
    identityValidation: false,
    keychain: '/fixture/signing.keychain',
    binaries: ['/fixture/extra-helper'],
    optionsForFile: (path) => ({ entitlements: `${path}.plist`, hardenedRuntime: true }),
    ignore: [(path) => path.includes('/orcad-template/')],
    preAutoEntitlements: false
  }
  let policy
  const result = await signAdhocMacApp(options, {
    async retry(task, retryOptions) {
      policy = retryOptions
      try {
        return await task()
      } catch (error) {
        expect(error).toBe(failure)
        return task()
      }
    },
    async sign(received) {
      calls.push(received)
      if (calls.length === 1) {
        throw failure
      }
      return 'signed'
    }
  })
  expect(result).toBe('signed')
  expect(policy).toEqual({ retries: 3, interval: 5000, backoff: 5000 })
  expect(calls).toHaveLength(2)
  expect(calls[0]).not.toBe(calls[1])
  for (const received of calls) {
    expect(received).toEqual({ ...options, batchCodesignCalls: true })
    expect(received.optionsForFile).toBe(options.optionsForFile)
    expect(received.optionsForFile('/fixture/helper')).toEqual({
      entitlements: '/fixture/helper.plist',
      hardenedRuntime: true
    })
    expect(received.ignore[0]('/fixture/orcad-template/helper')).toBe(true)
  }
  expect(options).not.toHaveProperty('batchCodesignCalls')
})

it('propagates signing failure after the retry policy is exhausted', async () => {
  const failure = new Error('signature verification failed')
  await expect(
    signAdhocMacApp(
      {},
      {
        retry: (task) => task(),
        sign: async () => {
          throw failure
        }
      }
    )
  ).rejects.toBe(failure)
})

it.each([
  { ORCA_MAC_ADHOC: '1' },
  {},
  { ORCA_MAC_RELEASE: '1' },
  { ORCA_MAC_HOURLY: '1' },
  { ORCA_MAC_DAILY: '1' },
  { ORCA_WIN_ADHOC: '1' }
])('only selects the batched signer for adhoc macOS builds: %j', async (env) => {
  const configPath = resolve('config/electron-builder.config.cjs')
  const saved = { ...process.env }
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('ORCA_')) {
        delete process.env[name]
      }
    }
    Object.assign(process.env, env)
    delete require.cache[configPath]
    const config = require(configPath)
    if (env.ORCA_MAC_ADHOC === '1') {
      expect(config.mac.sign).toBe(resolve('config/scripts/sign-adhoc-mac-app.mjs'))
      const hook = await resolveFunction(undefined, config.mac.sign, 'sign', process.cwd())
      expect(typeof hook).toBe('function')
      expect(hook.name).toBe('sign')
      expect(config.mac.signIgnore).toContain('/orcad-template/')
      expect(config.forceCodeSigning).toBe(true)
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.mac.notarize).toBe(true)
    } else {
      expect(config.mac.sign).toBeUndefined()
    }
  } finally {
    process.env = saved
    delete require.cache[configPath]
  }
})

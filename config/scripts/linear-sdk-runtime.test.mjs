import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { electronViteConfig } from '../../electron.vite.config'
import { runProcess } from '../../src/shared/child-process/run-process'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
let outputDir

const smokeScript = `
  const assert = require('node:assert/strict')
  const { createRequire } = require('node:module')
  const loaderPath = process.argv[1]
  const requireFromLoader = createRequire(loaderPath)
  const sdkEntry = requireFromLoader.resolve('@linear/sdk')
  const { loadLinearSdk } = require(loaderPath)
  assert.equal(require.cache[sdkEntry], undefined, 'SDK must remain lazy')

  const sdk = loadLinearSdk()
  assert.equal(sdk, requireFromLoader('@linear/sdk'))
  assert.equal(loadLinearSdk(), sdk, 'repeat loads must reuse the SDK')
  const client = new sdk.LinearClient({ apiKey: 'orca-offline-smoke-test' })
  assert.equal(typeof client.issues, 'function')
  assert.equal(typeof client.teams, 'function')
  assert.ok(sdk.AuthenticationLinearError.prototype instanceof Error)
  console.log('Linear SDK loaded')
`

beforeAll(async () => {
  // Keep normal dependency resolution while executing outside Vitest's module loader.
  outputDir = await mkdtemp(join(projectDir, 'node_modules', 'orca-linear-sdk-runtime-'))
  const mainBuild = electronViteConfig.main.build
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      minify: mainBuild.minify,
      outDir: outputDir,
      rollupOptions: {
        external: mainBuild.rollupOptions.external,
        input: join(projectDir, 'src/main/linear/linear-sdk.ts'),
        output: { format: 'cjs', entryFileNames: 'linear-sdk.cjs' }
      }
    }
  })
})

afterAll(async () => {
  if (outputDir) {
    await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('resolved Linear SDK through the production CommonJS loader', () => {
  it.each([
    { name: 'Node', program: process.execPath },
    { name: 'Electron', program: require('electron') }
  ])(
    'loads and constructs the real SDK under $name without network access',
    async ({ program }) => {
      const result = await runProcess({
        program,
        args: ['-e', smokeScript, join(outputDir, 'linear-sdk.cjs')],
        cwd: projectDir,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ELECTRON_RUN_AS_NODE: '1' },
        timeoutMs: 20000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stdout.trim()).toBe('Linear SDK loaded')
    }
  )
})

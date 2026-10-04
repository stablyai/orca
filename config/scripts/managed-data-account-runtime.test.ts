import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
let outputDir: string

beforeAll(async () => {
  outputDir = mkdtempSync(join(tmpdir(), 'orca-account-runtime-'))
  const resolved = await resolveConfig(
    { configFile: join(projectDir, 'electron.vite.config.ts') },
    'build',
    'production'
  )
  const main = resolved.config?.main
  if (!main?.build) {
    throw new Error('Expected main-process build config')
  }
  await build({
    ...main,
    logLevel: 'silent',
    build: {
      ...main.build,
      outDir: join(outputDir, 'bundle'),
      sourcemap: false,
      rollupOptions: {
        ...main.build.rollupOptions,
        input: join(projectDir, 'src/main/managed-data-accounts/credential-capture.ts'),
        output: { format: 'cjs', entryFileNames: 'credential-capture.cjs' }
      }
    }
  })
  mkdirSync(join(outputDir, 'source', 'devin'), { recursive: true })
  writeFileSync(
    join(outputDir, 'source', 'devin', 'credentials.toml'),
    'windsurf_api_key = "offline-account-runtime-fixture"\n'
  )
})

afterAll(() => {
  if (outputDir) {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

describe('managed account credentials in the production main bundle', () => {
  it.each([
    { name: 'Node', program: process.execPath },
    { name: 'Electron', program: require('electron') }
  ])(
    'captures Devin credentials under $name outside the dependency install',
    async ({ name, program }) => {
      const environment: Record<string, string | undefined> = {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ELECTRON_RUN_AS_NODE: '1'
      }
      for (const key of [
        'HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME'
      ]) {
        const directory = join(outputDir, name, key)
        mkdirSync(directory, { recursive: true })
        environment[key] = directory
      }
      const script = `
      const assert = require('node:assert/strict')
      const { captureDataAccountCredentials } = require(process.argv[1])
      captureDataAccountCredentials('devin', process.argv[2], process.argv[3])
        .then((integrations) => {
          assert.deepEqual(integrations, ['devin'])
          console.log('Private credentials captured')
        }).catch((error) => { console.error(error); process.exitCode = 1 })
    `
      const destination = join(outputDir, name, 'captured')
      const result = await runProcess({
        program,
        args: [
          '-e',
          script,
          join(outputDir, 'bundle', 'credential-capture.cjs'),
          join(outputDir, 'source'),
          destination
        ],
        cwd: outputDir,
        env: environment,
        timeoutMs: 20000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stdout.trim()).toBe('Private credentials captured')
      expect(readFileSync(join(destination, 'devin', 'credentials.toml'), 'utf8')).toContain(
        'offline-account-runtime-fixture'
      )
    }
  )
})

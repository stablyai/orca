import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type * as preparationModule from './opencode-wsl-runtime-preparation'

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  run: vi.fn(),
  running: vi.fn(async (paths: readonly string[], _options?: { requireConfirmed?: boolean }) => [
    ...paths
  ]),
  download: vi.fn(async () => 'C:\\cache\\node-v24.21.0-linux-arm64-musl.tar.gz'),
  bundles: vi.fn((platform: string) => [`C:/relay/${platform}`])
}))
vi.mock('node:fs', () => ({ existsSync: mocks.exists }))
vi.mock('../../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getAppPath: () => 'C:/app',
    getPath: () => 'C:/profile'
  })
}))
vi.mock('../../../../wsl/execution/wsl-runner', () => ({ runWslProcess: mocks.run }))
// The admission gate asks the running list for the path's distro; `running` stands in for it.
vi.mock('../../../../native-chat/wsl-transcript-running-admission', () => ({
  admitWslTranscriptPath: async (path: string) => {
    if ((await mocks.running([path], { requireConfirmed: true })).length === 0) {
      throw new Error('WSL distro is not running.')
    }
  }
}))
vi.mock('../../../../node-runtime/pinned-runtime-materializer', () => ({
  materializeNodeRuntimeArchive: mocks.download
}))
vi.mock('../../../../ssh/relay-bundle-paths', () => ({ relayBundleCandidates: mocks.bundles }))

const home = String.raw`\\wsl.localhost\Ubuntu\home\ada`
const success = (stdout: string) => ({ stdout, stderr: '', code: 0, timedOut: false })
let prepare: typeof preparationModule.prepareOpenCodeWslReaders

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.exists.mockReturnValue(true)
  mocks.running.mockImplementation(async (paths) => [...paths])
  mocks.run.mockImplementation(async (spec) =>
    success(
      spec.script?.startsWith('data=')
        ? 'present'
        : spec.program === 'wslpath'
          ? '/mnt/c/reader.cjs'
          : '/usr/bin/node'
    )
  )
  prepare = (await import('./opencode-wsl-runtime-preparation')).prepareOpenCodeWslReaders
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function prepared() {
  let result = await prepare([home])
  await vi.waitFor(async () => {
    result = await prepare([home])
    expect(result[0]?.executable).toBeDefined()
  })
  return result
}

describe('WSL SQLite runtime preparation', () => {
  it('checks the generated SQLite probe against missing API and stderr warnings locally', async () => {
    await prepared()
    const probe = mocks.run.mock.calls.find(([spec]) => spec.program === 'node')?.[0]
    expect(probe?.args[0]).toBe('-e')
    const directory = await mkdtemp(join(tmpdir(), 'orca-wsl-sqlite-probe-'))
    const runProbe = (preload: string) =>
      runProcess({
        program: process.execPath,
        args: probe.args,
        timeoutMs: 10_000,
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
      })
    try {
      // Node 22.13-22.15: DatabaseSync ships, the backup export does not.
      const withoutBackup = join(directory, 'node-22-13-sqlite.cjs')
      await writeFile(withoutBackup, "delete require('node:sqlite').backup")
      const rejected = await runProbe(withoutBackup)
      expect(rejected.code).not.toBe(0)
      expect(rejected.stdout).toBe('')
      const warning = join(directory, 'experimental-warning.cjs')
      await writeFile(
        warning,
        "process.emitWarning('SQLite is an experimental feature and might change at any time','ExperimentalWarning')"
      )
      const admitted = await runProbe(warning)
      expect(admitted.code, admitted.stderr).toBe(0)
      expect(admitted.stderr).toContain('ExperimentalWarning')
      expect(admitted.stdout.trim()).toBe(process.execPath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32').each(['opencode', 'zcode'] as const)(
    'presence script finds %s-only data despite unrelated OpenCode overrides',
    async (agent) => {
      await prepared()
      const script = mocks.run.mock.calls[0]?.[0].script
      const directory = await mkdtemp(join(tmpdir(), 'orca-wsl-presence-'))
      try {
        const data =
          agent === 'zcode'
            ? join(directory, '.zcode', 'cli', 'db')
            : join(directory, '.local', 'share', 'opencode')
        await mkdir(data, { recursive: true })
        await writeFile(join(data, agent === 'zcode' ? 'db.sqlite' : 'opencode.db'), '')
        const result = await runProcess({
          program: '/bin/sh',
          args: ['-c', script],
          env: {
            HOME: directory,
            XDG_DATA_HOME: join(directory, 'empty'),
            OPENCODE_DB: ':memory:'
          }
        })
        expect(result.code).toBe(0)
        expect(result.stdout).toBe('present')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})

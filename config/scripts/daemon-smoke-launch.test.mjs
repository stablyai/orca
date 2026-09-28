import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonSmokeEntry, daemonSmokeLaunchOptions } from './daemon-smoke-launch.mjs'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'daemon-smoke-launch-'))
  const runtime = join(root, 'out', 'cli-runtime', `${process.platform}-${process.arch}`)
  mkdirSync(runtime, { recursive: true })
  mkdirSync(join(root, 'out', 'terminal-daemon'))
  writeFileSync(daemonSmokeEntry(root), '// daemon fixture')
  const binary = join(runtime, 'bun-runtime')
  writeFileSync(binary, 'runtime fixture')
  writeFileSync(
    join(runtime, 'runtime.json'),
    JSON.stringify({
      target: `${process.platform}-${process.arch}${process.platform === 'linux' ? '-glibc' : ''}`,
      version: ORCAD_BUN_VERSION,
      sha256: createHash('sha256').update('runtime fixture').digest('hex')
    })
  )
  writeFileSync(
    join(runtime, 'LICENSE.md'),
    readFileSync(new URL('../../resources/licenses/bun/LICENSE.md', import.meta.url))
  )
  return { root, binary }
}

test.skipIf(process.platform === 'win32')(
  'launch options use standalone Bun and reject altered runtime bytes',
  () => {
    const { root, binary } = fixture()
    try {
      const launch = daemonSmokeLaunchOptions(root, root, {
        NODE_OPTIONS: 'injected',
        NODE_PATH: 'foreign',
        BUN_OPTIONS: 'foreign',
        BUN_INSPECT: 'foreign',
        BUN_INSPECT_BRK: 'foreign',
        BUN_INSPECT_WAIT: 'foreign',
        ELECTRON_RUN_AS_NODE: '1',
        BUN_CONPTY_LIBRARY: 'foreign'
      })
      assert.equal(launch.program, binary)
      assert.equal(launch.entryPath, join(root, 'out', 'terminal-daemon', 'daemon-entry.js'))
      assert.equal(launch.options.cwd, root)
      assert.equal(launch.options.env.ORCA_BACKGROUND_LAUNCH, '1')
      for (const key of [
        'NODE_OPTIONS',
        'NODE_PATH',
        'BUN_OPTIONS',
        'BUN_INSPECT',
        'BUN_INSPECT_BRK',
        'BUN_INSPECT_WAIT',
        'ELECTRON_RUN_AS_NODE',
        'BUN_CONPTY_LIBRARY'
      ]) {
        assert.equal(launch.options.env[key], undefined)
      }
      assert.deepEqual(launch.options.stdio, ['ignore', 'ignore', 'pipe', 'ipc'])
      writeFileSync(binary, 'tampered')
      assert.throws(() => daemonSmokeLaunchOptions(root, root), /checksum mismatch/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('every lifecycle smoke uses the standalone verified launch path', () => {
  for (const name of [
    'daemon-boot-smoke',
    'daemon-endpoint-handover-smoke',
    'windows-daemon-workspace-close-repro'
  ]) {
    const source = readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8')
    assert.match(source, /spawnDaemonSmoke\(/)
    assert.doesNotMatch(source, /\bfork\(/)
    assert.doesNotMatch(source, /'out', 'main'/)
  }
  const boot = readFileSync(new URL('./daemon-boot-smoke.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(boot, /best-effort|health check skipped/i)
  const workflow = readFileSync(
    new URL('../../.github/workflows/computer-e2e.yml', import.meta.url),
    'utf8'
  )
  assert.ok(
    workflow.indexOf('run: pnpm run build:terminal-daemon') <
      workflow.indexOf('name: Daemon boot smoke')
  )
})

test('Windows launch fixes the provider selector and suppresses inherited runtime injection', () => {
  const source = readFileSync(new URL('./daemon-smoke-launch.mjs', import.meta.url), 'utf8')
  assert.match(source, /verifyCliRuntimeDirectory\(runtimeDir, process.platform, process.arch\)/)
  assert.match(source, /daemonEnv.BUN_CONPTY_LIBRARY = join\(runtimeDir, 'conpty', 'conpty.dll'\)/)
  assert.match(source, /\[\.\.\.bunOwnedRuntimeArgs\(\), launch.entryPath, \.\.\.args\]/)
  assert.match(source, /windowsHide: true/)
})

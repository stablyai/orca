import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWslWatcher, type WatchedRoot } from './filesystem-watcher-wsl'
import { ensureWslWatcherRuntime } from './filesystem-watcher-wsl-runtime'

const execFileAsync = promisify(execFile)
const runLive = process.platform === 'win32' && process.env.ORCA_WSL_WATCHER_LIVE === '1'
const fixturePath = `/tmp/orca-wsl-watcher-${process.pid}`
let distro = ''

async function runWsl(...args: string[]): Promise<string> {
  const result = await execFileAsync('wsl.exe', ['--', ...args], {
    encoding: 'utf8'
  })
  return result.stdout
}

describe.skipIf(!runLive)('WSL watcher live integration', () => {
  beforeAll(async () => {
    distro = (await runWsl('printenv', 'WSL_DISTRO_NAME')).trim()
    await runWsl('mkdir', '-p', `${fixturePath}/docs/deep`)
    await runWsl('mkdir', '-p', `${fixturePath}/packages/app/node_modules/pkg`)
    await runWsl('touch', `${fixturePath}/docs/deep/README.md`)
    await runWsl('touch', `${fixturePath}/packages/app/node_modules/pkg/ignored.js`)
  })

  afterAll(async () => {
    // Why: keep recursive cleanup constrained to the unique test directory.
    if (fixturePath.startsWith('/tmp/orca-wsl-watcher-')) {
      await runWsl('rm', '-rf', '--', fixturePath)
    }
  })

  it('reports a deep external edit without periodic polling events', async () => {
    const rootPath = `\\\\wsl.localhost\\${distro}${fixturePath.replace(/\//g, '\\')}`
    const runtime = await ensureWslWatcherRuntime(distro)
    await execFileAsync('wsl.exe', ['-d', distro, '--', 'test', '-x', runtime.nodePath])
    const batches: WatchedRoot[] = []
    const root = await createWslWatcher(rootPath, rootPath, {
      ignoreDirs: ['node_modules', '.git'],
      scheduleBatchFlush: (_rootKey, watchedRoot) => batches.push(watchedRoot)
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      expect(batches).toHaveLength(0)

      await runWsl('touch', `${fixturePath}/docs/deep/README.md`)
      await vi.waitFor(
        () => {
          expect(root.batch.events).toContainEqual({
            type: 'update',
            path: `${rootPath}\\docs\\deep\\README.md`
          })
        },
        // Native event delivery should not need to wait for the 5-second scan fallback.
        { timeout: 2_000 }
      )

      root.batch.events = []
      batches.length = 0
      await runWsl('touch', `${fixturePath}/packages/app/node_modules/pkg/ignored.js`)
      await new Promise((resolve) => setTimeout(resolve, 750))
      expect(batches).toHaveLength(0)
      expect(root.batch.events).toHaveLength(0)
    } finally {
      await root.subscription.unsubscribe()
    }
  }, 15_000)
})

import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import { startDevStorageReclaim } from './dev-storage-reclaim.mjs'

function fixture() {
  const child = new EventEmitter()
  child.unref = vi.fn()
  const spawn = vi.fn(() => child)
  return { child, spawn, report: vi.fn(), repoRoot: '/dev-worktree', env: {} }
}

it('starts one non-interactive worker without waiting for its exit', () => {
  const options = fixture()
  startDevStorageReclaim(options)
  expect(options.spawn).toHaveBeenCalledTimes(1)
  expect(options.spawn.mock.calls[0][0]).toMatchObject({
    args: expect.arrayContaining([
      '--automatic',
      '--apply',
      '--exclude-worktree',
      options.repoRoot
    ]),
    detached: true,
    stdio: 'ignore'
  })
  expect(options.child.unref).toHaveBeenCalledTimes(1)
  expect(options.report).not.toHaveBeenCalled()
})

it('allows tests and developers to skip the repository-wide sweep', () => {
  const options = fixture()
  startDevStorageReclaim({ ...options, env: { ORCA_SKIP_DEV_STORAGE_RECLAIM: '1' } })
  expect(options.spawn).not.toHaveBeenCalled()
})

it('reports cleanup failure without throwing into dev startup', () => {
  const options = fixture()
  startDevStorageReclaim(options)
  options.child.emit('exit', 1)
  expect(options.report).toHaveBeenCalledWith(expect.stringContaining('pnpm reclaim-space'))
})

it.each([true, false])('handles both sync and async spawn errors (sync: %j)', (synchronous) => {
  const options = fixture()
  if (synchronous) {
    options.spawn.mockImplementation(() => {
      throw new Error('spawn failed')
    })
  }
  expect(() => startDevStorageReclaim(options)).not.toThrow()
  if (!synchronous) {
    options.child.emit('error', new Error('spawn failed'))
  }
  expect(options.report).toHaveBeenCalledWith(expect.stringContaining('spawn failed'))
})

it('closes captured dev output before the detached worker exits', async () => {
  const entry = pathToFileURL(resolve(import.meta.dirname, 'dev-storage-reclaim.mjs')).href
  const result = await runProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `import { startDevStorageReclaim } from ${JSON.stringify(entry)};
       import { spawnProcess } from '@orca/process-host';
       startDevStorageReclaim({
         repoRoot: ${JSON.stringify(tmpdir())},
         env: { ...process.env, ORCA_SKIP_DEV_STORAGE_RECLAIM: '0' },
         spawn: (spec) => spawnProcess({ ...spec, args: ['-e', 'setTimeout(() => {}, 5000)'] })
       });
       process.exit(0);`
    ],
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 2_000,
    terminationBarrier: true
  })
  expect(result.timedOut).toBe(false)
  expect(result.code, result.stderr).toBe(0)
})

import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  checkDaemonSocketPathBudget,
  getDaemonRuntimeDirPath,
  getDaemonSocketBindPath,
  getDaemonSocketPath
} from './daemon-runtime-paths'
import { UNIX_SOCKET_PATH_LIMIT, unixSocketPathBytes } from '../../shared/unix-socket-path-budget'

/** A data root whose daemon socket path lands on exactly `bytes`, or null if it cannot. */
function rootForSocketBytes(base: string, bytes: number): string | null {
  const sample = `${base}/r`
  const overhead =
    unixSocketPathBytes(getDaemonSocketPath(getDaemonRuntimeDirPath(sample))) -
    unixSocketPathBytes(sample)
  const rootBytes = bytes - overhead
  const prefix = `${base}/`
  if (rootBytes < unixSocketPathBytes(prefix)) {
    return null
  }
  return prefix + 'x'.repeat(rootBytes - unixSocketPathBytes(prefix))
}

describe('daemon socket path budget', () => {
  it('measures the canonical endpoint, which is the longest name bound', () => {
    const root = '/home/orca/.orca'
    const socketPath = getDaemonSocketPath(getDaemonRuntimeDirPath(root))
    const budget = checkDaemonSocketPathBudget(root)
    expect(budget.longestPath).toBe(socketPath)
    // The private bind name is shorter by construction; if it ever stops being, the budget
    // follows it rather than silently under-measuring.
    expect(unixSocketPathBytes(getDaemonSocketBindPath(socketPath))).toBeLessThan(budget.bytes)
  })

  it('fits an ordinary root and refuses a long one', () => {
    expect(checkDaemonSocketPathBudget('/home/orca/.orca').fits).toBe(true)
    expect(checkDaemonSocketPathBudget(`/home/${'x'.repeat(200)}/.orca`).fits).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('flips at exactly the limit', () => {
    const atLimit = rootForSocketBytes('/tmp', UNIX_SOCKET_PATH_LIMIT)
    const overLimit = rootForSocketBytes('/tmp', UNIX_SOCKET_PATH_LIMIT + 1)
    expect(atLimit).not.toBeNull()
    expect(checkDaemonSocketPathBudget(atLimit as string).fits).toBe(true)
    expect(checkDaemonSocketPathBudget(overLimit as string).fits).toBe(false)
  })
})

/**
 * Ties the constant to the kernel. Without this the budget is a number in a file that nothing
 * disagrees with, and the defect it exists to prevent — a daemon that cannot bind — is exactly
 * what a wrong number reintroduces.
 *
 * The assertion is "a socket exists at the path", not an errno, because past the limit there is
 * no single failure: on Linux a slightly-too-long path fails EADDRINUSE against a free name, and
 * a longer one reports a successful listen with no directory entry at all. A stat-able entry is
 * the property `publishDaemonEndpoint` is built on — it identifies the endpoint by dev+ino — so
 * it is the property worth asserting.
 */
describe('the limit is the kernel’s', () => {
  function bindable(socketPath: string): Promise<boolean> {
    mkdirSync(dirname(socketPath), { recursive: true })
    const server = createServer()
    return new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(socketPath, () => resolve(existsSync(socketPath)))
    }).finally(() => new Promise((done) => server.close(() => done(null))))
  }

  it.skipIf(process.platform === 'win32')(
    'binds at the limit and produces no endpoint past it',
    async () => {
      // A short base: the socket path has to be built to an exact length, and macOS tmpdir is
      // already long enough to make that impossible.
      const base = mkdtempSync(join(tmpdir(), 'sb-'))
      try {
        const under = join(base, 'a'.repeat(UNIX_SOCKET_PATH_LIMIT - base.length - 2))
        const over = `${under}bb`
        expect(unixSocketPathBytes(under)).toBe(UNIX_SOCKET_PATH_LIMIT - 1)
        expect(await bindable(under)).toBe(true)
        expect(unixSocketPathBytes(over)).toBe(UNIX_SOCKET_PATH_LIMIT + 1)
        expect(await bindable(over)).toBe(false)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }
  )
})

import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { getMacDaemonSystemResolverHealth } from './daemon-health'
import type * as ResolverHealthModule from '../network/macos-system-resolver-health'
import type { SubprocessHandle } from './session-subprocess-handle'

vi.mock('../network/macos-system-resolver-health', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolverHealthModule>()),
  readCurrentProcessMacSystemResolverHealth: async () => 'healthy' as const
}))

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

// The probe answers 'unknown' off macOS without touching the socket.
describe.skipIf(process.platform !== 'darwin')('macOS daemon resolver health probe', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-resolver-probe-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers concurrent probes without one waiting out the timeout', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()

    try {
      const startedAt = Date.now()
      const results = await Promise.all([
        getMacDaemonSystemResolverHealth(socketPath, tokenPath),
        getMacDaemonSystemResolverHealth(socketPath, tokenPath),
        getMacDaemonSystemResolverHealth(socketPath, tokenPath)
      ])
      expect(results).toEqual(['healthy', 'healthy', 'healthy'])
      expect(Date.now() - startedAt).toBeLessThan(1_500)
    } finally {
      await server.shutdown()
    }
  })

  it('settles as unknown as soon as the daemon closes the probe socket', async () => {
    writeFileSync(tokenPath, 'token', { mode: 0o600 })
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write(`${JSON.stringify({ type: 'hello', ok: true })}\n`)
        socket.once('data', () => socket.end())
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    try {
      const startedAt = Date.now()
      await expect(getMacDaemonSystemResolverHealth(socketPath, tokenPath)).resolves.toBe('unknown')
      expect(Date.now() - startedAt).toBeLessThan(1_500)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

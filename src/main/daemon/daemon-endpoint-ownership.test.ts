import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath, publishDaemonPidFile } from './daemon-spawner'
import { readDaemonSocketIdentity } from './daemon-endpoint-ownership'
import type { SubprocessHandle } from './session'

function connectsTo(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath })
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

describe('daemon endpoint ownership publication', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-ownership-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not publish an adoptable endpoint before durable ownership succeeds', async () => {
    writeFileSync(tokenPath, 'previous-token')
    const publishEndpointOwnership = vi.fn(() => {
      expect(readFileSync(tokenPath, 'utf8')).toBe('previous-token')
      throw Object.assign(new Error('PID record already owned'), {
        code: 'EEXIST'
      })
    })
    server = new DaemonServer({
      socketPath,
      tokenPath,
      publishEndpointOwnership,
      spawnSubprocess: () => createMockSubprocess()
    })

    await expect(server.start()).rejects.toThrow('PID record already owned')

    expect(publishEndpointOwnership).toHaveBeenCalledOnce()
    expect(readFileSync(tokenPath, 'utf8')).toBe('previous-token')
    if (process.platform !== 'win32') {
      expect(existsSync(socketPath)).toBe(false)
    }
  })

  it('rolls back exact PID ownership when token publication fails', async () => {
    const pidPath = join(dir, 'daemon.pid')
    const launchNonce = 'failed-launch'
    mkdirSync(tokenPath)
    server = new DaemonServer({
      socketPath,
      tokenPath,
      pidPath,
      launchNonce,
      publishEndpointOwnership: () =>
        publishDaemonPidFile(pidPath, {
          pid: process.pid,
          startedAtMs: 1_000,
          launchNonce
        }),
      spawnSubprocess: () => createMockSubprocess()
    })

    await expect(server.start()).rejects.toMatchObject({ code: 'EISDIR' })

    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a replacement endpoint when the daemon it replaced closes late',
    async () => {
      // Why: this is the split-brain mechanism. libuv unlinks the pathname a server bound to
      // when that server closes, with no ownership check — so a daemon exiting late used to
      // delete whichever socket then sat at the canonical path. The replacement stayed alive
      // hosting PTYs that no client could reach, which is what "terminals ack but never run"
      // looked like from the user's seat.
      const replacedPidPath = join(dir, 'replaced.pid')
      const replaced = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath: replacedPidPath,
        launchNonce: 'replaced-daemon',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(replacedPidPath, {
            pid: process.pid,
            startedAtMs: 1_000,
            launchNonce: 'replaced-daemon'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      await replaced.start()

      // A replacement reclaims the endpoint the way killStaleDaemon does.
      unlinkSync(socketPath)
      const pidPath = join(dir, 'replacement.pid')
      server = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath,
        launchNonce: 'replacement-daemon',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(pidPath, {
            pid: process.pid,
            startedAtMs: 2_000,
            launchNonce: 'replacement-daemon'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const replacementIdentity = readDaemonSocketIdentity(socketPath)

      // The daemon that lost the endpoint now exits, long after the handover.
      await replaced.shutdown()

      expect(existsSync(socketPath)).toBe(true)
      expect(readDaemonSocketIdentity(socketPath)).toEqual(replacementIdentity)
      // The replacement is still reachable through the canonical name.
      await expect(connectsTo(socketPath)).resolves.toBe(true)
      // The late exit also must not remove the replacement's ownership record.
      expect(existsSync(pidPath)).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retires a daemon whose endpoint was taken over by another daemon',
    async () => {
      const pidPath = join(dir, 'daemon.pid')
      server = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath,
        launchNonce: 'original-daemon',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(pidPath, {
            pid: process.pid,
            startedAtMs: 1_000,
            launchNonce: 'original-daemon'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()

      const daemon = server as unknown as {
        checkEndpointOwnership: () => void
        retirementRequested: boolean
      }
      // An inconclusive or matching probe must never retire a healthy daemon, however often it runs.
      daemon.checkEndpointOwnership()
      daemon.checkEndpointOwnership()
      expect(daemon.retirementRequested).toBe(false)

      // Another daemon takes the endpoint name.
      unlinkSync(socketPath)
      const usurper = createServer()
      const usurperBind = join(dir, '.usurper')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      linkSync(usurperBind, socketPath)
      unlinkSync(usurperBind)

      try {
        // A single observation can land inside a replacement's unlink-then-link gap, so the
        // first one must not retire anything.
        daemon.checkEndpointOwnership()
        expect(daemon.retirementRequested).toBe(false)

        daemon.checkEndpointOwnership()
        // Why: retirement drains rather than kills — an orphaned daemon stops being a
        // permanent unreachable host without tearing live sessions out from under the user.
        expect(daemon.retirementRequested).toBe(true)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
        try {
          unlinkSync(socketPath)
        } catch {
          // Already gone.
        }
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a second listener when a live daemon socket path was removed',
    async () => {
      const pidPath = join(dir, 'daemon.pid')
      server = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath,
        launchNonce: 'first-launch',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(pidPath, {
            pid: process.pid,
            startedAtMs: 1_000,
            launchNonce: 'first-launch'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const firstToken = readFileSync(tokenPath, 'utf8')
      unlinkSync(socketPath)

      const duplicate = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath,
        launchNonce: 'second-launch',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(pidPath, {
            pid: process.pid,
            startedAtMs: 2_000,
            launchNonce: 'second-launch'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      try {
        await expect(duplicate.start()).rejects.toMatchObject({
          code: 'EEXIST'
        })
        expect(readFileSync(tokenPath, 'utf8')).toBe(firstToken)
        expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toMatchObject({
          startedAtMs: 1_000,
          launchNonce: 'first-launch'
        })
      } finally {
        await duplicate.shutdown()
      }
    }
  )
})

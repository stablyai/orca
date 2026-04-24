import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, connect, type Server } from 'net'
import { DaemonServer } from './daemon-server'
import { getDaemonPidPath } from './daemon-spawner'
import { healthCheckDaemon, killStaleDaemon } from './daemon-health'
import type { SubprocessHandle } from './session'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    write() {},
    resize() {},
    kill() {},
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {}
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 500)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

describe('daemon health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes when a daemon answers ping', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()

    try {
      await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(true)
    } finally {
      await server.shutdown()
    }
  })

  it('fails when the token file is missing', async () => {
    await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(false)
  })

  it('does not unlink a live socket when the pid file does not match this daemon', async () => {
    if (process.platform === 'win32') {
      return
    }

    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    writeFileSync(getDaemonPidPath(dir), String(process.pid), { mode: 0o600 })

    try {
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(false)
      await expect(canConnect(socketPath)).resolves.toBe(true)
    } finally {
      await closeServer(server)
    }
  })
})

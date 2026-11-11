import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer, connect, type Server } from 'node:net'
import { getDaemonPidPath, serializeDaemonPidFile } from '../../launch/daemon-spawner'
import { killStaleDaemon } from '../../launch/daemon-stale-kill'

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

function daemonTestSocketPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(dir)}-daemon.sock`
    : join(dir, 'daemon.sock')
}

describe('daemon health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-test-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not unlink a live socket when the pid file does not match this daemon', async () => {
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
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toMatchObject({
        killed: false
      })
      await expect(canConnect(socketPath)).resolves.toBe(true)
    } finally {
      await closeServer(server)
    }
  })
})

describe('killStaleDaemon ownership decisions', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-kill-test-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('preserves a daemon that cannot be proven dead', async () => {
    const record = serializeDaemonPidFile({
      pid: process.pid,
      startedAtMs: null,
      launchNonce: 'live-owner'
    })
    writeFileSync(getDaemonPidPath(dir), record, { mode: 0o600 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    try {
      await expect(
        killStaleDaemon(dir, socketPath, tokenPath, undefined, {
          probeEndpoint: async () => 'unknown'
        })
      ).resolves.toEqual({ killed: false, liveOwnerSurvived: true })
      expect(readFileSync(getDaemonPidPath(dir), 'utf8')).toBe(record)
    } finally {
      killSpy.mockRestore()
    }
  })
})

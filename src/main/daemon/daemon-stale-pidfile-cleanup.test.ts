import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killStaleDaemon } from './daemon-health'
import {
  getDaemonPidPath,
  serializeDaemonPidFile,
  unlinkUnchangedDaemonPidFile
} from './daemon-spawner'

function socketPathFor(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(dir)}-stale-pid.sock`
    : join(dir, 'daemon.sock')
}

describe('stale daemon pidfile cleanup', () => {
  let dir: string
  let pidPath: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-stale-pidfile-'))
    pidPath = getDaemonPidPath(dir)
    socketPath = socketPathFor(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('clears a dead process record so an exclusive relaunch can publish', async () => {
    const child = spawn(process.execPath, ['-e', ''])
    const deadPid = child.pid
    expect(deadPid).toEqual(expect.any(Number))
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    writeFileSync(
      pidPath,
      serializeDaemonPidFile({
        pid: deadPid!,
        startedAtMs: null
      }),
      { mode: 0o600 }
    )

    await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(false)
    expect(existsSync(pidPath)).toBe(false)

    const replacement = serializeDaemonPidFile({
      pid: process.pid,
      startedAtMs: null,
      launchNonce: 'replacement'
    })
    expect(() => writeFileSync(pidPath, replacement, { mode: 0o600, flag: 'wx' })).not.toThrow()
    expect(readFileSync(pidPath, 'utf8')).toBe(replacement)
  })

  it('removes a killed legacy record so an exclusive relaunch can publish', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.send?.('ready');setInterval(()=>{},1000)",
        'daemon-entry',
        socketPath,
        tokenPath
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    await new Promise<void>((resolve) => {
      child.on('message', (message) => {
        if (message === 'ready') {
          resolve()
        }
      })
    })
    writeFileSync(
      pidPath,
      serializeDaemonPidFile({
        pid: child.pid!,
        startedAtMs: null
      }),
      { mode: 0o600 }
    )

    try {
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(true)
      expect(existsSync(pidPath)).toBe(false)
      expect(() =>
        writeFileSync(
          pidPath,
          serializeDaemonPidFile({
            pid: process.pid,
            startedAtMs: null,
            launchNonce: 'replacement'
          }),
          { mode: 0o600, flag: 'wx' }
        )
      ).not.toThrow()
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    }
  })

  it('preserves matching POSIX command evidence when the start time is inconclusive', async () => {
    if (process.platform === 'win32') {
      return
    }
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.send?.('ready');setInterval(()=>{},1000)",
        'daemon-entry',
        socketPath,
        tokenPath
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    await new Promise<void>((resolve) => {
      child.on('message', (message) => {
        if (message === 'ready') {
          resolve()
        }
      })
    })
    const record = serializeDaemonPidFile({
      pid: child.pid!,
      startedAtMs: Date.now() - 5_000,
      launchNonce: 'slow-bootstrap'
    })
    writeFileSync(pidPath, record, { mode: 0o600 })

    try {
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(false)
      expect(readFileSync(pidPath, 'utf8')).toBe(record)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('preserves the exact record when process access is rejected', async () => {
    const record = serializeDaemonPidFile({
      pid: process.pid,
      startedAtMs: null,
      launchNonce: 'inaccessible'
    })
    writeFileSync(pidPath, record, { mode: 0o600 })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(false)
    expect(readFileSync(pidPath, 'utf8')).toBe(record)
  })

  it('preserves a replacement that no longer matches the stale contents', () => {
    const stale = serializeDaemonPidFile({ pid: 1, startedAtMs: null })
    const replacement = serializeDaemonPidFile({
      pid: 2,
      startedAtMs: null,
      launchNonce: 'replacement'
    })
    writeFileSync(pidPath, replacement, { mode: 0o600 })

    expect(unlinkUnchangedDaemonPidFile(pidPath, stale)).toBe(false)
    expect(readFileSync(pidPath, 'utf8')).toBe(replacement)
  })
})

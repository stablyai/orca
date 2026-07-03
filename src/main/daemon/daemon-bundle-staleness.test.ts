import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import { getProcessStartedAtMs, isDaemonStaleForCurrentBundle } from './daemon-health'

function spawnDaemonLikeProcess(socketPath: string, tokenPath: string) {
  return spawn(
    process.execPath,
    [
      '-e',
      'setTimeout(() => {}, 30000)',
      'daemon-entry',
      '--socket',
      socketPath,
      '--token',
      tokenPath
    ],
    { stdio: 'ignore' }
  )
}

async function getStartedAtMs(pid: number | undefined): Promise<number | null> {
  if (!pid) {
    return null
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  return getProcessStartedAtMs(pid)
}

describe('daemon bundle staleness', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-bundle-staleness-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects packaged daemon staleness by app version', async () => {
    if (process.platform === 'win32') {
      return
    }

    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }

      const entryPath = join(dir, 'daemon-entry.js')
      writeFileSync(entryPath, '', 'utf8')
      writeFileSync(
        getDaemonPidPath(dir),
        serializeDaemonPidFile({
          pid: child.pid,
          startedAtMs,
          entryPath,
          appVersion: '1.2.2'
        }),
        { mode: 0o600 }
      )

      expect(await isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('preserves same-version packaged daemon reuse', async () => {
    if (process.platform === 'win32') {
      return
    }

    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }

      const entryPath = join(dir, 'daemon-entry.js')
      writeFileSync(entryPath, '', 'utf8')
      writeFileSync(
        getDaemonPidPath(dir),
        serializeDaemonPidFile({
          pid: child.pid,
          startedAtMs,
          entryPath,
          appVersion: '1.2.3'
        }),
        { mode: 0o600 }
      )

      expect(await isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('replaces legacy packaged daemons without version metadata', async () => {
    if (process.platform === 'win32') {
      return
    }

    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }

      const entryPath = join(dir, 'daemon-entry.js')
      writeFileSync(entryPath, '', 'utf8')
      writeFileSync(
        getDaemonPidPath(dir),
        serializeDaemonPidFile({
          pid: child.pid,
          startedAtMs,
          entryPath
        }),
        { mode: 0o600 }
      )

      expect(await isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })
})

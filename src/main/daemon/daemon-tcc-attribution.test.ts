import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import {
  getMacDaemonTccAttributionHealth,
  getProcessStartedAtMs,
  parseDaemonPidFile
} from './daemon-health'

// Real-process harness (same shape as daemon-bundle-staleness.test.ts): the health
// check only trusts a pid record whose process is verifiably the daemon, so these
// tests spawn a daemon-shaped child instead of mocking process identity.
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

describe('parseDaemonPidFile spawnerExecPath', () => {
  it('round-trips the spawner exec path', () => {
    const parsed = parseDaemonPidFile(
      serializeDaemonPidFile({
        pid: 123,
        startedAtMs: 1,
        spawnerExecPath: '/Applications/Orca.app/Contents/MacOS/Orca'
      })
    )
    expect(parsed?.spawnerExecPath).toBe('/Applications/Orca.app/Contents/MacOS/Orca')
  })

  it('reads legacy records without a spawner exec path as null', () => {
    expect(
      parseDaemonPidFile(serializeDaemonPidFile({ pid: 123, startedAtMs: 1 }))?.spawnerExecPath
    ).toBeNull()
    expect(parseDaemonPidFile('123')?.spawnerExecPath).toBeNull()
  })
})

describe('macOS daemon TCC attribution health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-tcc-attribution-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function withDaemonLikeProcess(
    run: (writePidFile: (extra: Record<string, unknown>) => void) => Promise<void>
  ): Promise<void> {
    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }
      const writePidFile = (extra: Record<string, unknown>): void => {
        writeFileSync(
          getDaemonPidPath(dir),
          JSON.stringify({ pid: child.pid, startedAtMs, ...extra }),
          { mode: 0o600 }
        )
      }
      await run(writePidFile)
    } finally {
      child.kill('SIGKILL')
    }
  }

  it('reports severed when the recorded spawning binary no longer exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({ spawnerExecPath: join(dir, 'deleted-bundle', 'Orca') })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
        'severed'
      )
    })
  })

  it('reports intact when the recorded spawning binary still exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      const spawnerPath = join(dir, 'Orca')
      writeFileSync(spawnerPath, '', 'utf8')
      writePidFile({ spawnerExecPath: spawnerPath })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
        'intact'
      )
    })
  })

  it('reports severed after a packaged update reuses the spawning binary path', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      const spawnerPath = join(dir, 'Orca')
      writeFileSync(spawnerPath, '', 'utf8')
      writePidFile({ spawnerExecPath: spawnerPath, appVersion: '1.2.2' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
        'severed'
      )
    })
  })

  it('flags legacy records only on a packaged app-version change', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({ appVersion: '1.2.2' })
      // Updater replaced the bundle since this daemon was forked → attribution is gone.
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
        'severed'
      )
      writePidFile({ appVersion: '1.2.3' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
        'unknown'
      )
      // Dev builds pass null — no version heuristic, fail open.
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, null)).toBe(
        'unknown'
      )
    })
  })

  it('fails open when no verifiable pid record exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
      'unknown'
    )
  })

  it('reports unknown off macOS', async () => {
    if (process.platform === 'darwin') {
      return
    }
    expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, '1.2.3')).toBe(
      'unknown'
    )
  })
})

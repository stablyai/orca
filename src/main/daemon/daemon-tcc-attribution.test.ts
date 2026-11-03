import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonPidPath } from './daemon-spawner'

import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { getProcessStartedAtMs } from './daemon-process-start-time'
import { MAC_TERMINAL_HOST_EXECUTABLE } from './macos-daemon-bundle'

const appEnvironment = vi.hoisted(() => ({ packaged: true }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ isPackaged: () => appEnvironment.packaged })
}))

// Exercise real PID verification with a child whose argv matches the daemon.
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
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('severed')
    })
  })

  it('reports intact after an app-version change when the spawning binary path still exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      const spawnerPath = join(dir, 'Orca')
      writeFileSync(spawnerPath, '', 'utf8')
      writePidFile({ spawnerExecPath: spawnerPath, appVersion: '1.2.2' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('intact')
    })
  })

  describe('after the app that forked the daemon has exited', () => {
    const originalGetSystemVersion = Object.getOwnPropertyDescriptor(process, 'getSystemVersion')
    let orphanPid: number | null = null

    beforeEach(() => {
      Object.defineProperty(process, 'getSystemVersion', {
        configurable: true,
        value: () => '27.2.0'
      })
    })

    afterEach(() => {
      if (originalGetSystemVersion) {
        Object.defineProperty(process, 'getSystemVersion', originalGetSystemVersion)
      } else {
        Reflect.deleteProperty(process, 'getSystemVersion')
      }
      if (orphanPid) {
        process.kill(orphanPid, 'SIGKILL')
        orphanPid = null
      }
    })

    // The intermediate shell exits at once, so launchd adopts the daemon-like process.
    async function writeOrphanedDaemonPidFile(
      spawnerExecPath: string,
      launchArgs: string
    ): Promise<void> {
      writeFileSync(spawnerExecPath, '', 'utf8')
      const pid = await new Promise<number>((resolve, reject) => {
        const shell = spawn(
          '/bin/sh',
          [
            '-c',
            `"$0" -e "setTimeout(() => {}, 30000)" daemon-entry --socket "$1" --token "$2" ${launchArgs} >/dev/null 2>&1 & echo $!`,
            process.execPath,
            socketPath,
            tokenPath
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        )
        let stdout = ''
        shell.stdout.on('data', (chunk) => (stdout += String(chunk)))
        shell.on('error', reject)
        shell.on('close', () => resolve(Number(stdout.trim())))
      })
      orphanPid = pid
      const startedAtMs = await getStartedAtMs(pid)
      writeFileSync(getDaemonPidPath(dir), JSON.stringify({ pid, startedAtMs, spawnerExecPath }), {
        mode: 0o600
      })
    }

    it.each([
      {
        name: 'a forked daemon is severed even though the app binary still exists',
        spawner: 'Orca',
        launchArgs: '--login-session-watch',
        packaged: true,
        health: 'severed'
      },
      {
        name: 'the launchd terminal host is intact because it is its own responsible process',
        spawner: MAC_TERMINAL_HOST_EXECUTABLE,
        launchArgs: '--login-session-watch',
        packaged: true,
        health: 'intact'
      },
      {
        name: 'an unpackaged fork is intact because a restart would only fork again',
        spawner: 'Orca',
        launchArgs: '--login-session-watch',
        packaged: false,
        health: 'intact'
      },
      {
        name: 'a headless host is intact because its exited parent may not have been responsible',
        spawner: 'Orca',
        launchArgs: '',
        packaged: true,
        health: 'intact'
      }
    ])('$name', async ({ spawner, launchArgs, packaged, health }) => {
      if (process.platform !== 'darwin') {
        return
      }
      appEnvironment.packaged = packaged
      await writeOrphanedDaemonPidFile(join(dir, spawner), launchArgs)
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe(health)
    })
  })

  it('fails open without a recorded spawning binary', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('unknown')
      writePidFile({ appVersion: '1.2.2' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('unknown')
      writePidFile({ appVersion: '1.2.3' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('unknown')
    })
  })
})

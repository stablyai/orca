import { spawnProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isWindowsProcessTableAvailable,
  readWindowsProcessCreationTime
} from '../windows/windows-process-table'
import { inspectDaemonProcessIdentity } from './daemon-pid-identity'

const socketPath = 'C:\\orca-test\\daemon-v4.sock'
const tokenPath = 'C:\\orca-test\\daemon-v4.token'

describe.runIf(process.platform === 'win32')(
  'daemon PID identity on the real process table',
  () => {
    let stop: (() => void) | undefined

    afterEach(() => {
      stop?.()
      stop = undefined
    })

    it('matches a live daemon and rejects the same PID under a different start time', async () => {
      // Native, so this proves the check no longer forks powershell.exe.
      expect(isWindowsProcessTableAvailable()).toBe(true)
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)', 'daemon-entry', socketPath, tokenPath],
        stdio: 'ignore'
      })
      stop = () => child.kill()
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid
      if (pid === undefined) {
        throw new Error('fake daemon did not start')
      }
      const createdAtMs = readWindowsProcessCreationTime(pid)
      if (createdAtMs === null) {
        throw new Error('native creation time unavailable')
      }

      await expect(
        inspectDaemonProcessIdentity(pid, socketPath, tokenPath, createdAtMs)
      ).resolves.toBe('match')
      // A reused PID is the same number with a creation time far from the pid file's.
      await expect(
        inspectDaemonProcessIdentity(pid, socketPath, tokenPath, createdAtMs - 60 * 60_000)
      ).resolves.toBe('mismatch')
      await expect(
        inspectDaemonProcessIdentity(pid, 'C:\\other\\daemon.sock', tokenPath, createdAtMs)
      ).resolves.toBe('mismatch')
    })
  }
)

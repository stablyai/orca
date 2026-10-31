import { once } from 'node:events'
import { closeSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import { openDarwinPortScanLock } from './darwin-port-scan-lock'
import { runPortScanCommandInProcess } from './port-scan-command-execution'
import {
  PortScanCommandTimeoutError,
  type DarwinPortScanOperation
} from './port-scan-command-protocol'

function supportedFilesystemLock(operation: DarwinPortScanOperation): number {
  const fd = openDarwinPortScanLock(operation)
  if (fd === null) {
    throw new Error('This fixture requires a lock-supported filesystem.')
  }
  return fd
}

// Cooperative children terminate themselves; no kernel hangs or process-tree signalling.
describe.runIf(process.platform === 'darwin')('Darwin operation admission', () => {
  const owned = new Set<ChildProcess>()
  afterEach(() => {
    for (const child of owned) {
      if (child.exitCode === null) {
        child.kill()
      }
    }
    owned.clear()
  })

  // Real process startup and the 1.5s orphan lifetime need headroom on loaded runners.
  it('keeps independent slots excluded after the owning client exits and recovers on child exit', async () => {
    const fd = supportedFilesystemLock('attribution')
    let parent: ChildProcess
    try {
      parent = spawnProcess({
        program: process.execPath,
        args: [
          '-e',
          `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'],
          {stdio: [0, 'ignore', 'ignore']});
        child.unref();
      `
        ],
        stdio: [fd, 'pipe', 'pipe']
      })
      owned.add(parent)
    } finally {
      closeSync(fd)
    }
    await once(parent, 'exit')
    expect(() => openDarwinPortScanLock('attribution')).toThrow()
    closeSync(supportedFilesystemLock('listeners'))
    // ast-grep-ignore: test-no-real-time-wait -- The orphan releases its kernel lock on real exit; fake timers cannot advance it.
    await new Promise((resolve) => setTimeout(resolve, 1700))
    closeSync(supportedFilesystemLock('attribution'))
    await expect(
      runPortScanCommandInProcess('/missing/sta-11266', [], 'attribution')
    ).rejects.toThrow()
    closeSync(supportedFilesystemLock('attribution'))
  }, 10_000)

  // Exercises the real 4s command timeout followed by the child's 4.6s natural exit.
  it('settles a caller timeout while the actual child retains admission, then allows recovery', async () => {
    const probe = runPortScanCommandInProcess(
      process.execPath,
      [
        '-e',
        `
      process.on('SIGTERM', () => {});
      setTimeout(() => process.exit(0), 4600);
    `
      ],
      'attribution'
    )
    await expect(probe).rejects.toBeInstanceOf(PortScanCommandTimeoutError)
    expect(() => openDarwinPortScanLock('attribution')).toThrow()
    closeSync(supportedFilesystemLock('listeners'))
    // ast-grep-ignore: test-no-real-time-wait -- The timed-out child must naturally exit and release its kernel lock.
    await new Promise((resolve) => setTimeout(resolve, 900))
    const recovered = await runPortScanCommandInProcess(
      process.execPath,
      ['-e', 'console.log("recovered")'],
      'attribution'
    )
    expect(recovered.stdout).toBe('recovered\n')
  }, 10_000)

  it('rejects a zero-status listener diagnostic rather than claiming a complete empty table', async () => {
    await expect(
      runPortScanCommandInProcess(
        process.execPath,
        ['-e', 'console.error("fixture diagnostic")'],
        'listeners'
      )
    ).rejects.toThrow()
    closeSync(supportedFilesystemLock('listeners'))
  })
})

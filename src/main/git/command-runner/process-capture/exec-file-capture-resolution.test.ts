import { setImmediate as nextTurn } from 'node:timers/promises'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeExecutableResolver } from '@orca/process-host/native-executable-resolution'
import * as nativeSpawn from '@orca/process-host/native-process-spawn'
import { beginLocalCommandSelection } from '../../../ipc/command-path/command-path-resolver'
import { execFileCapture } from './exec-file-capture'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'darwin')('Mac capture during executable lookup', () => {
  it.each(['abort', 'deadline'] as const)(
    'settles %s before lookup completes without launching late',
    async (reason) => {
      let release!: (selection: { program: string; file: string }) => void
      vi.spyOn(nativeExecutableResolver, 'resolveAsync').mockReturnValue(
        new Promise((resolve) => {
          release = resolve
        })
      )
      const spawn = vi.spyOn(nativeSpawn, 'spawnNativeProcess')
      const controller = new AbortController()
      const terminated = vi.fn()
      const deadline = vi.fn()
      const pending = execFileCapture(process.execPath, ['-e', 'throw Error("launched late")'], {
        signal: controller.signal,
        ...(reason === 'deadline' ? { timeout: 1 } : {}),
        onChildTerminated: terminated,
        onDeadlineKill: deadline
      })
      const rejected = expect(pending).rejects.toThrow(reason === 'abort' ? 'aborted' : 'timed out')
      if (reason === 'abort') {
        controller.abort()
      }
      await rejected
      release({ program: process.execPath, file: process.execPath })
      await nextTurn()
      expect(spawn).not.toHaveBeenCalled()
      expect(terminated).toHaveBeenCalledOnce()
      expect(deadline).toHaveBeenCalledTimes(reason === 'deadline' ? 1 : 0)
    }
  )

  it('keeps the preflight-selected CLI ahead of an earlier executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-capture-selection-'))
    roots.push(root)
    const first = join(root, 'first')
    const second = join(root, 'second')
    await Promise.all([mkdir(first), mkdir(second)])
    const earlier = join(first, 'gh')
    const selected = join(second, 'gh')
    await Promise.all([
      writeFile(earlier, '#!/bin/sh\necho wrong\n'),
      symlink(process.execPath, selected)
    ])
    await chmod(earlier, 0o755)
    vi.stubEnv('PATH', `${first}:${second}`)
    const publish = beginLocalCommandSelection('gh')
    try {
      await publish(selected)
      await expect(
        execFileCapture('gh', ['-p', 'process.argv0'], { timeout: 2_000 })
      ).resolves.toEqual({
        stdout: 'gh\n',
        stderr: ''
      })
    } finally {
      await publish(null)
    }
  })

  it('preserves raw buffers and stderr observation on a failed command', async () => {
    const observed: string[] = []
    await expect(
      execFileCapture(
        process.execPath,
        [
          '-e',
          'process.stdout.write(Buffer.from([0,255,128]));process.stderr.write("diagnostic");process.exitCode=7'
        ],
        {
          encoding: 'buffer',
          onStderr: (chunk) => observed.push(chunk),
          timeout: 2_000
        }
      )
    ).rejects.toMatchObject({
      code: 7,
      stdout: Buffer.from([0, 255, 128]),
      stderr: Buffer.from('diagnostic')
    })
    expect(observed.join('')).toBe('diagnostic')
  })
})

describe.skipIf(process.platform !== 'darwin')('capture output overflow termination', () => {
  it('keeps the deadline and termination obligation alive when the child ignores the overflow signal', async () => {
    const original = nativeSpawn.spawnNativeProcess
    let child: ReturnType<typeof original> | undefined
    vi.spyOn(nativeSpawn, 'spawnNativeProcess').mockImplementation((...args) => {
      child = original(...args)
      return child
    })
    let reportTermination!: () => void
    const terminated = new Promise<void>((resolve) => {
      reportTermination = resolve
    })
    const onTerminated = vi.fn(reportTermination)
    const signals: string[] = []
    try {
      await expect(
        execFileCapture(
          process.execPath,
          [
            '-e',
            `
        let signals = 0;
        process.on('SIGTERM', () => {
          if (++signals === 1) process.stderr.write('first');
          else process.stderr.write('second', () => process.exit(0));
        });
        setInterval(() => {}, 1000);
        process.stdout.write('x'.repeat(64));
      `
          ],
          {
            maxBuffer: 32,
            timeout: 3_000,
            onChildTerminated: onTerminated,
            onStderr: (chunk) => signals.push(chunk)
          }
        )
      ).rejects.toThrow('timed out')
      await terminated
      expect(onTerminated).toHaveBeenCalledOnce()
      expect(signals.join('')).toBe('firstsecond')
    } finally {
      // The test owns this exact returned child, including when the regression assertion fails.
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  })
})

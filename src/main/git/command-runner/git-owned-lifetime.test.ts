import { afterEach, describe, expect, it, vi } from 'vitest'
import * as nativeSpawn from '@orca/process-host/native-process-spawn'
import * as tree from '@orca/process-host/process-tree-termination'
import { nativeExecutableResolver } from '@orca/process-host/native-executable-resolution'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { GitAdmissionScheduler } from '../../../shared/git/admission/git-admission-scheduler'
import { _resetGitAdmissionForTests } from './admission/git-subprocess-admission'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { gitStreamStdout } from './git-stream-stdout'

function ownedChildren() {
  const children: ReturnType<typeof createFakeSpawnedChild>[] = []
  const proofs = new Map<number, (verified: boolean) => void>()
  vi.spyOn(nativeExecutableResolver, 'resolveAsync').mockImplementation(async (program) => ({
    program,
    file: program
  }))
  vi.spyOn(nativeSpawn, 'spawnNativeProcess').mockImplementation(() => {
    const child = createFakeSpawnedChild(900_000 + children.length)
    children.push(child)
    return child
  })
  vi.spyOn(tree, 'processGroupExists').mockReturnValue(true)
  const term = vi.spyOn(tree, 'signalProcessTree').mockResolvedValue(true)
  const force = vi
    .spyOn(tree, 'forceTerminateProcessTree')
    .mockImplementation(
      (child) => new Promise<boolean>((resolve) => proofs.set(child.pid!, resolve))
    )
  return { children, proofs, term, force }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  _resetGitAdmissionForTests()
})

describe.skipIf(process.platform === 'win32')('owned native Git lifetime', () => {
  it.each([30, 300])(
    'bounds admitted resources and a live successor with %i canceled requests',
    async (population) => {
      vi.useFakeTimers()
      const fixture = ownedChildren()
      const scheduler = new GitAdmissionScheduler()
      _resetGitAdmissionForTests(scheduler)
      const options = {
        cwd: process.cwd(),
        admissionClass: 'checkout' as const,
        admissionTier: 'interactive' as const
      }
      const controllers = Array.from({ length: population }, () => new AbortController())
      const pending = controllers.map((controller, index) =>
        gitExecFileAsync(['worktree', 'add', `owned-${index}`], {
          ...options,
          signal: controller.signal
        }).catch((error: unknown) => error)
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.children).toHaveLength(3)
      controllers.forEach((controller) => controller.abort())
      await Promise.all(pending)
      const successor = gitExecFileAsync(['worktree', 'add', 'successor'], options)
      fixture.children.forEach((child) => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(fixture.children).toHaveLength(3)
      expect(scheduler.snapshot().budgets.checkout).toEqual({ baseUsed: 2, headroomUsed: 1 })
      fixture.proofs.get(fixture.children[0].pid)?.(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.children).toHaveLength(4)
      fixture.children[3].stdout.emit('data', Buffer.from('successor completed'))
      fixture.children[3].emit('close', 0, null)
      await expect(successor).resolves.toEqual({ stdout: 'successor completed', stderr: '' })
      for (const proof of fixture.proofs.values()) {
        proof(true)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(scheduler.snapshot().budgets.checkout).toEqual({ baseUsed: 0, headroomUsed: 0 })
      expect(scheduler.snapshot().queued).toBe(0)
      // Explicit perf contract: stops scale with admitted roots, never queued population.
      expect(fixture.term).toHaveBeenCalledTimes(3)
      expect(fixture.force).toHaveBeenCalledTimes(3)
    }
  )

  it.each([30, 300])('completes %i normal reads without termination probes', async (population) => {
    vi.useFakeTimers()
    const fixture = ownedChildren()
    let done = 0
    const reads = Array.from({ length: population }, () =>
      gitExecFileAsyncBuffer(['cat-file', 'blob', 'HEAD:file'], { cwd: process.cwd() })
    )
    while (done < population) {
      await vi.advanceTimersByTimeAsync(0)
      for (const child of fixture.children.slice(done)) {
        child.stdout.emit('data', Buffer.from([0, 255, 128]))
        child.emit('close', 0, null)
        done++
      }
    }
    const results = await Promise.all(reads)
    expect(results).toHaveLength(population)
    expect(results.every(({ stdout }) => stdout.equals(Buffer.from([0, 255, 128])))).toBe(true)
    expect(fixture.term).not.toHaveBeenCalled()
    expect(fixture.force).not.toHaveBeenCalled()
    expect(tree.processGroupExists).not.toHaveBeenCalled()
  })

  it.each(['early', 'parser', 'stdout-cap', 'stderr-cap', 'abort', 'timeout'] as const)(
    'retains stream admission after %s and root close until group proof',
    async (reason) => {
      vi.useFakeTimers()
      const fixture = ownedChildren()
      const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
      _resetGitAdmissionForTests(scheduler)
      const controller = new AbortController()
      const stream = gitStreamStdout(['status', '--porcelain'], {
        cwd: process.cwd(),
        signal: controller.signal,
        maxBuffer: 8,
        ...(reason === 'timeout' ? { timeoutMs: 10 } : {}),
        onStdout: () => {
          if (reason === 'parser') {
            throw new Error('malformed record')
          }
          return true
        }
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      const child = fixture.children[0]
      if (reason === 'abort') {
        controller.abort()
      } else if (reason === 'timeout') {
        await vi.advanceTimersByTimeAsync(10)
      } else if (reason === 'stderr-cap') {
        child.stderr.emit('data', Buffer.from('123456789'))
      } else {
        child.stdout.emit('data', Buffer.from(reason === 'stdout-cap' ? '123456789' : 'record'))
      }
      const outcome = await stream
      if (reason === 'early') {
        expect(outcome).toEqual({ stoppedEarly: true })
      } else {
        expect(outcome).toBeInstanceOf(Error)
      }
      const successor = gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: process.cwd() })
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(fixture.children).toHaveLength(1)
      fixture.proofs.get(child.pid)?.(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.children).toHaveLength(2)
      fixture.children[1].stdout.emit('data', Buffer.from('abc'))
      fixture.children[1].emit('close', 0, null)
      await expect(successor).resolves.toEqual({ stdout: 'abc', stderr: '' })
    }
  )
})

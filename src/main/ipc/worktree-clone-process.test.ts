import { describe, expect, it, vi } from 'vitest'
import type { runProcess, ProcessResult } from '../../shared/child-process/run-process'
import { runWorktreeCloneProcess } from './worktree-clone-process'

const result: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  outputTruncated: false
}

describe('runWorktreeCloneProcess', () => {
  it('bounds output and duration and requires confirmed termination', async () => {
    const run = vi.fn<typeof runProcess>(async (spec) => {
      spec.onChildTerminated?.()
      return result
    })
    await expect(
      runWorktreeCloneProcess({ program: '/bin/cp', args: [], timeoutMs: null }, run)
    ).resolves.toEqual(result)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 120_000,
        maxOutputBytes: 16 * 1024,
        detached: true,
        terminationBarrier: true
      })
    )
  })

  it.each([true, false])('reports timeout with verified exit=%s', async (verified) => {
    const run = vi.fn<typeof runProcess>(async (spec) => {
      if (verified) {
        spec.onChildTerminated?.()
      }
      return { ...result, timedOut: true }
    })
    await expect(runWorktreeCloneProcess({ program: '/bin/cp' }, run)).rejects.toMatchObject({
      termination: verified ? 'exited' : 'unverifiable'
    })
  })

  it('does not infer termination from a settled result or rejected runner', async () => {
    for (const run of [
      vi.fn<typeof runProcess>().mockResolvedValue(result),
      vi.fn<typeof runProcess>().mockRejectedValue(new Error('lost contact'))
    ]) {
      await expect(runWorktreeCloneProcess({ program: '/bin/cp' }, run)).rejects.toMatchObject({
        termination: 'unverifiable'
      })
    }
  })
  it('confirms exit after timing out a real child', async () => {
    await expect(
      runWorktreeCloneProcess({
        program: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 100
      })
    ).rejects.toMatchObject({ termination: 'exited' })
  })
})

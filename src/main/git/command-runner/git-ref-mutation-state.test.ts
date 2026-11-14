import { afterEach, expect, it, vi } from 'vitest'
import type * as Capture from './process-capture/exec-file-capture'

const io = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('./process-capture/exec-file-capture', async (original) => ({
  ...(await original<typeof Capture>()),
  execFileCapture: io.capture
}))
import { trackGitRefMutation } from './git-ref-mutation-state'
import { gitExecFileAsync } from './git-exec-file'
import { subscribeGitRefChanges } from '../refs/git-ref-change-signal'

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  io.capture.mockReset()
})

it('preserves warm refs for reads and proven object/index operations, and fences all for ref writes', () => {
  const events: string[] = []
  disposers.push(subscribeGitRefChanges('/a/.git', () => events.push('a')))
  disposers.push(subscribeGitRefChanges('/b/.git', () => events.push('b')))
  for (const args of [
    ['for-each-ref'],
    ['remote'],
    ['config', '--get', 'remote.origin.url'],
    ['worktree', 'list', '--porcelain'],
    ['ls-remote'],
    ['add', '.'],
    ['update-index', '--refresh'],
    ['hash-object', '-w', 'file'],
    ['restore', '--staged', '.'],
    ['apply', '--cached'],
    ['merge-tree', '--write-tree']
  ]) {
    trackGitRefMutation(args)()
  }
  expect(events).toEqual([])
  for (const args of [
    ['commit'],
    ['push'],
    ['pull'],
    ['fetch'],
    ['branch', 'topic'],
    ['config', 'remote.origin.url', 'url'],
    ['worktree', 'add', 'path'],
    ['custom-alias']
  ]) {
    const end = trackGitRefMutation(args)
    expect(events.splice(0)).toEqual(['a', 'b'])
    end()
    end()
    expect(events.splice(0)).toEqual(['a', 'b'])
  }
})

it('keeps the runner completion fence at child termination after a timed-out caller settles', async () => {
  const events: string[] = []
  disposers.push(subscribeGitRefChanges('/runner-a/.git', () => events.push('a')))
  disposers.push(subscribeGitRefChanges('/runner-b/.git', () => events.push('b')))
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let terminated!: () => void
  let rejectCapture!: (error: Error) => void
  io.capture.mockImplementationOnce((_command, _args, options) => {
    terminated = options.onChildTerminated
    started()
    return new Promise((_resolve, reject) => {
      rejectCapture = reject
    })
  })
  const result = gitExecFileAsync(['branch', 'topic'], {
    cwd: process.cwd(),
    admissionExempt: true
  })
  expect(events.splice(0)).toEqual(['a', 'b'])
  await ready
  const failure = expect(result).rejects.toThrow('deadline')
  rejectCapture(new Error('deadline'))
  await failure
  expect(events).toEqual([])
  disposers.push(subscribeGitRefChanges('/runner-new/.git', () => events.push('new')))
  terminated()
  await new Promise<void>(setImmediate)
  expect(events).toEqual(['a', 'b', 'new'])
})

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitFetchHeadLockModule from '../../../shared/git-fetch-head-lock'

const {
  execFileMock,
  spawnMock,
  killSpawnedCommandTreeMock,
  signalProcessTreeMock,
  forceTerminateProcessTreeMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  killSpawnedCommandTreeMock: vi.fn().mockResolvedValue(undefined),
  signalProcessTreeMock: vi.fn().mockResolvedValue(false),
  forceTerminateProcessTreeMock: vi.fn().mockResolvedValue(false)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
  spawn: spawnMock
}))
vi.mock('./spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: killSpawnedCommandTreeMock
}))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalProcessTreeMock,
  forceTerminateProcessTree: forceTerminateProcessTreeMock
}))
// Mock only filesystem key derivation so libuv completion order cannot reorder the real FIFO lock.
vi.mock('../../../shared/git-fetch-head-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof GitFetchHeadLockModule>()
  const { runWithGitOperationLock } = await import('../../../shared/git-operation-lock')
  return {
    ...actual,
    runWithGitFetchHeadLock: <T>(
      worktreePath: string,
      signal: AbortSignal | undefined,
      run: () => Promise<T>
    ): Promise<T> => runWithGitOperationLock(worktreePath, signal, run)
  }
})

import { RuntimeRemoteFetchController } from '../../runtime/runtime-remote-fetch-controller'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { execFileCapture } from './exec-file-capture'
import { isGitWorktreeMutationInFlight } from '../git-worktree-mutation-state'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

type ExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void

function mockChild(pid: number | undefined = 1234): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

function mockMissingSshConfig(callback: ExecCallback): ChildProcess {
  const child = mockChild()
  queueMicrotask(() => {
    callback(Object.assign(new Error('No SSH configuration'), { code: 1 }), '', '')
    child.emit('close', 1, null)
  })
  return child
}

async function settleAdmissionGrant(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('git exec admission lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    execFileMock.mockReset()
    spawnMock.mockReset()
    killSpawnedCommandTreeMock.mockClear()
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    _resetGitAdmissionForTests()
  })

  it('keeps the SSH policy probe queued beyond its execution budget until caller cancellation', async () => {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
    const holding = acquireGitAdmission({ args: ['status'], cwd: '/repo' })
    await settleAdmissionGrant()
    const blocker = await holding
    const controller = new AbortController()
    const pending = gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: { ...process.env, GIT_SSH_COMMAND: '' },
      useConfiguredSshCommandForNetwork: true,
      signal: controller.signal
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await settleAdmissionGrant()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(_gitAdmissionSnapshotForTests().queued).toBe(1)
    expect(execFileMock).not.toHaveBeenCalled()
    controller.abort()
    await rejection
    blocker.release()
    expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
  })

  it.each([false, true])(
    'never spawns an expired preview after admission (late timer: %s)',
    async (lateTimer) => {
      vi.stubEnv('GIT_SSH_COMMAND', 'ssh')
      _resetGitAdmissionForTests(new GitAdmissionScheduler({ networkCap: 1, networkHeadroom: 0 }))
      const blocker = await acquireGitAdmission({ args: ['fetch'], cwd: '/preview' })
      const controller = new RuntimeRemoteFetchController()
      vi.spyOn(controller, 'getCanonicalRepoKey').mockResolvedValue('local::/preview/.git')
      const preview = controller.refreshRemoteTrackingBaseForPreview('/preview', {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        base: 'origin/main'
      })
      await settleAdmissionGrant()
      expect(_gitAdmissionSnapshotForTests().queued).toBe(1)
      vi.setSystemTime(Date.now() + (lateTimer ? 10_001 : 0))
      await vi.advanceTimersByTimeAsync(lateTimer ? 0 : 10_001)
      blocker.release()
      await settleAdmissionGrant()
      await expect(preview).resolves.toEqual({ ok: false, errorKind: 'git_error' })
      expect(execFileMock).not.toHaveBeenCalled()
    }
  )

  it.each(['timeout', 'abort'] as const)(
    'retains the string-exec permit and mutation after %s until close',
    async (reason) => {
      const child = mockChild()
      execFileMock.mockReturnValue(child)
      const controller = new AbortController()
      const pending = gitExecFileAsync(['rebase', '--continue'], {
        cwd: '/repo',
        timeout: 10,
        signal: controller.signal
      })
      const rejection = expect(pending).rejects.toThrow(
        reason === 'timeout' ? 'timed out' : 'aborted'
      )
      await settleAdmissionGrant()
      expect(execFileMock).toHaveBeenCalledOnce()
      await expect(isGitWorktreeMutationInFlight('/repo', {})).resolves.toBe(true)

      if (reason === 'timeout') {
        await vi.advanceTimersByTimeAsync(10)
      } else {
        controller.abort()
      }
      await rejection
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
      const mutationBeforeClose = await isGitWorktreeMutationInFlight('/repo', {})

      child.emit('close', null, 'SIGKILL')
      await Promise.resolve()
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
      expect(mutationBeforeClose).toBe(true)
      await expect(isGitWorktreeMutationInFlight('/repo', {})).resolves.toBe(false)
    }
  )

  it('retains the buffer-exec permit after maxBuffer settlement until close', async () => {
    const child = mockChild()
    let callback: ExecCallback | undefined
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, received: ExecCallback) => {
        callback = received
        return child
      }
    )
    const pending = gitExecFileAsyncBuffer(['show', 'HEAD:file'], { cwd: '/repo' })
    await vi.waitFor(() => expect(callback).toBeTypeOf('function'))

    callback?.(new Error('maxBuffer exceeded'), Buffer.alloc(0), Buffer.alloc(0))
    await expect(pending).rejects.toThrow('maxBuffer exceeded')
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', null, 'SIGTERM')
    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('does not admit a same-repo fetch while it waits for the FETCH_HEAD lock', async () => {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ networkCap: 2, networkHeadroom: 0 }))
    const children = [mockChild(1001), mockChild(1002)]
    const callbacks: ExecCallback[] = []
    execFileMock.mockImplementation(
      (_command: string, args: string[], _options: unknown, callback: ExecCallback) => {
        if (args[0] === 'config') {
          return mockMissingSshConfig(callback)
        }
        callbacks.push(callback)
        return children[callbacks.length - 1]
      }
    )

    const first = gitExecFileAsync(['fetch', 'origin'], { cwd: '/same-repo' })
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    const second = gitExecFileAsync(['fetch', 'origin'], { cwd: '/same-repo' })
    await Promise.resolve()

    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(_gitAdmissionSnapshotForTests()).toMatchObject({
      queued: 0,
      budgets: { network: { baseUsed: 1, headroomUsed: 0 } }
    })

    callbacks[0]?.(null, '', '')
    children[0].emit('close', 0, null)
    await expect(first).resolves.toEqual({ stdout: '', stderr: '' })
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))
    expect(execFileMock).toHaveBeenCalledTimes(4)
    callbacks[1]?.(null, '', '')
    children[1].emit('close', 0, null)
    await expect(second).resolves.toEqual({ stdout: '', stderr: '' })
    expect(_gitAdmissionSnapshotForTests().budgets.network?.baseUsed).toBe(0)
  })

  it('reports pre-aborted capture as a no-child termination', async () => {
    const controller = new AbortController()
    const onChildTerminated = vi.fn()
    controller.abort()

    await expect(
      execFileCapture('git', ['status'], {
        signal: controller.signal,
        onChildTerminated
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(execFileMock).not.toHaveBeenCalled()
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('releases termination-barrier admission on confirmed close', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = gitExecFileAsync(['status'], {
      cwd: '/repo',
      terminationBarrier: true
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', 0, null)
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' })
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('retains barrier admission past bounded settlement until termination is observed', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = gitExecFileAsync(['rebase', '--continue'], {
      cwd: '/repo',
      terminationBarrier: true,
      timeout: 10
    })
    const rejection = expect(pending).rejects.toThrow('timed out')
    await settleAdmissionGrant()
    expect(spawnMock).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(2010)
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
    const mutationBeforeClose = await isGitWorktreeMutationInFlight('/repo', {})

    child.emit('close', null, 'SIGKILL')
    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    expect(mutationBeforeClose).toBe(true)
    await expect(isGitWorktreeMutationInFlight('/repo', {})).resolves.toBe(false)
  })

  it.each([false, true])(
    'waits beyond the execution timeout before spawning (buffer: %s)',
    async (buffer) => {
      _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
      const holding = acquireGitAdmission({ args: ['status'], cwd: '/repo' })
      await settleAdmissionGrant()
      const blocker = await holding
      const child = mockChild()
      let callback: ExecCallback | undefined
      execFileMock.mockImplementation((_command, _args, _options, received: ExecCallback) => {
        callback = received
        return child
      })
      const pending = buffer
        ? gitExecFileAsyncBuffer(['status'], { cwd: '/repo', timeout: 50 })
        : gitExecFileAsync(['status'], { cwd: '/repo', timeout: 50 })
      await settleAdmissionGrant()
      await vi.advanceTimersByTimeAsync(500)
      expect(execFileMock).not.toHaveBeenCalled()
      expect(_gitAdmissionSnapshotForTests().queued).toBe(1)
      blocker.release()
      await settleAdmissionGrant()
      expect(execFileMock).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(49)
      callback?.(null, buffer ? Buffer.from('ok') : 'ok', buffer ? Buffer.alloc(0) : '')
      child.emit('close', 0, null)
      expect((await pending).stdout.toString()).toBe('ok')
      expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    }
  )

  it('still reports a caller abort of a queued command as an abort', async () => {
    vi.useRealTimers()
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
    const blocker = mockChild()
    let finishBlocker: ExecCallback | undefined
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        finishBlocker = callback
        return blocker
      }
    )
    const holding = gitExecFileAsync(['status'], { cwd: '/repo' })
    await vi.waitFor(() => expect(finishBlocker).toBeTypeOf('function'))

    const controller = new AbortController()
    const queued = gitExecFileAsync(['rebase', '--continue'], {
      cwd: '/repo',
      timeout: 60_000,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
    await expect(isGitWorktreeMutationInFlight('/repo', {})).resolves.toBe(true)
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(execFileMock).toHaveBeenCalledOnce()
    await expect(isGitWorktreeMutationInFlight('/repo', {})).resolves.toBe(false)

    finishBlocker?.(null, '', '')
    blocker.emit('close', 0, null)
    await expect(holding).resolves.toEqual({ stdout: '', stderr: '' })
  })

  it('serializes FETCH_HEAD callers before they enter admission', async () => {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ networkCap: 1, networkHeadroom: 1 }))
    const children = new Map<string, ChildProcess>()
    const callbacks = new Map<string, ExecCallback>()
    execFileMock.mockImplementation(
      (_command: string, args: string[], _options: unknown, callback: ExecCallback) => {
        if (args[0] === 'config') {
          return mockMissingSshConfig(callback)
        }
        const label = args[1] ?? ''
        const child = mockChild()
        children.set(label, child)
        callbacks.set(label, callback)
        return child
      }
    )

    const first = gitExecFileAsync(['fetch', 'first'], {
      cwd: '/repo',
      admissionTier: 'background'
    })
    await vi.waitFor(() => expect(callbacks.has('first')).toBe(true))
    const background = gitExecFileAsync(['fetch', 'background'], {
      cwd: '/repo',
      admissionTier: 'background'
    })
    const interactive = gitExecFileAsync(['fetch', 'interactive'], {
      cwd: '/repo',
      admissionTier: 'interactive'
    })

    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
    expect([...callbacks.keys()]).toEqual(['first'])

    callbacks.get('first')?.(null, '', '')
    await expect(first).resolves.toEqual({ stdout: '', stderr: '' })
    await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
    expect([...callbacks.keys()]).toEqual(['first'])

    children.get('first')?.emit('close', 0, null)
    await vi.waitFor(() => expect(callbacks.has('background')).toBe(true))
    expect([...callbacks.keys()]).toEqual(['first', 'background'])

    callbacks.get('background')?.(null, '', '')
    await expect(background).resolves.toEqual({ stdout: '', stderr: '' })
    await vi.waitFor(() => expect(callbacks.has('interactive')).toBe(true))

    children.get('background')?.emit('close', 0, null)
    callbacks.get('interactive')?.(null, '', '')
    await expect(interactive).resolves.toEqual({ stdout: '', stderr: '' })
    children.get('interactive')?.emit('close', 0, null)
  })
})

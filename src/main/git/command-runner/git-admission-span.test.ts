import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock, span, withGitSpanMock, startGitSpanMock } = vi.hoisted(() => {
  const span = {
    setAttribute: vi.fn(),
    end: vi.fn(),
    fail: vi.fn()
  }
  return {
    execFileMock: vi.fn(),
    spawnMock: vi.fn(),
    span,
    withGitSpanMock: vi.fn(async (_attributes: unknown, run: (value: typeof span) => unknown) => {
      try {
        const result = await run(span)
        span.end()
        return result
      } catch (error) {
        span.fail(error)
        throw error
      }
    }),
    startGitSpanMock: vi.fn(() => span)
  }
})

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
  spawn: spawnMock
}))
vi.mock('../../observability/instrumentation', () => ({
  withGitSpan: withGitSpanMock,
  startGitSpan: startGitSpanMock
}))

import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { withGitAdmission } from './git-spawn'
import { gitStreamStdout } from './git-stream-stdout'
import {
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

type ExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void

function mockChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = 1234
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

async function queueBehindBlocker(): Promise<{
  release: () => void
  advance: () => void
}> {
  let now = 0
  const scheduler = new GitAdmissionScheduler({
    generalCap: 1,
    generalHeadroom: 0,
    now: () => now
  })
  _resetGitAdmissionForTests(scheduler)
  const blocker = await scheduler.acquire({ args: ['status'], cwd: '/blocker' })
  return {
    release: blocker.release,
    advance: () => {
      now = 37
    }
  }
}

async function releaseQueued(blocker: { release: () => void; advance: () => void }): Promise<void> {
  await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
  blocker.advance()
  blocker.release()
}

describe('git admission span coverage', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    span.setAttribute.mockReset()
    span.end.mockReset()
    span.fail.mockReset()
    withGitSpanMock.mockClear()
    startGitSpanMock.mockClear()
  })

  afterEach(() => _resetGitAdmissionForTests())

  it('records queue wait for string exec inside its span', async () => {
    const blocker = await queueBehindBlocker()
    const child = mockChild()
    let callback: ExecCallback | undefined
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, received: ExecCallback) => {
        callback = received
        return child
      }
    )
    const pending = gitExecFileAsync(['status'], { cwd: '/repo' })
    await releaseQueued(blocker)
    await vi.waitFor(() => expect(callback).toBeTypeOf('function'))

    child.emit('close', 0, null)
    callback?.(null, 'ok', '')
    await expect(pending).resolves.toEqual({ stdout: 'ok', stderr: '' })
    expect(span.setAttribute).toHaveBeenCalledWith('git.queue_wait_ms', 37)
    expect(span.end).toHaveBeenCalledOnce()
  })

  it('records queue wait for buffer exec inside its span', async () => {
    const blocker = await queueBehindBlocker()
    const child = mockChild()
    let callback: ExecCallback | undefined
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, received: ExecCallback) => {
        callback = received
        return child
      }
    )
    const pending = gitExecFileAsyncBuffer(['show', 'HEAD:file'], { cwd: '/repo' })
    await releaseQueued(blocker)
    await vi.waitFor(() => expect(callback).toBeTypeOf('function'))

    child.emit('close', 0, null)
    callback?.(null, Buffer.from('blob'), Buffer.alloc(0))
    await expect(pending).resolves.toEqual({ stdout: Buffer.from('blob') })
    expect(span.setAttribute).toHaveBeenCalledWith('git.queue_wait_ms', 37)
    expect(span.end).toHaveBeenCalledOnce()
  })

  it('records queue wait for stream exec inside its span', async () => {
    const blocker = await queueBehindBlocker()
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = gitStreamStdout(['status'], { cwd: '/repo', onStdout: () => {} })
    await releaseQueued(blocker)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

    child.emit('close', 0, null)
    await expect(pending).resolves.toEqual({ stoppedEarly: false })
    expect(span.setAttribute).toHaveBeenCalledWith('git.queue_wait_ms', 37)
    expect(span.end).toHaveBeenCalledOnce()
  })

  it('keeps the manual spawn span open through queue wait and child close', async () => {
    const blocker = await queueBehindBlocker()
    const child = mockChild()
    const pending = withGitAdmission(['status'], { cwd: '/repo' }, () => child)
    await releaseQueued(blocker)
    await expect(pending).resolves.toBe(child)

    expect(span.setAttribute).toHaveBeenCalledWith('git.queue_wait_ms', 37)
    expect(span.end).not.toHaveBeenCalled()
    child.emit('close', 0, null)
    expect(span.end).toHaveBeenCalledOnce()
    expect(span.fail).not.toHaveBeenCalled()
  })
})

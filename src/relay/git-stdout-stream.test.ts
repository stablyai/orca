import type * as ProcessRunner from '@orca/process-host'
import type * as ProcessTreeTermination from '@orca/process-host/process-tree-termination'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, terminateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importActual) => ({
  ...(await importActual<typeof ProcessRunner>()),
  spawnProcess: spawnMock
}))
vi.mock('@orca/process-host/process-tree-termination', async (importActual) => ({
  ...(await importActual<typeof ProcessTreeTermination>()),
  forceTerminateProcessTree: terminateMock
}))

import { GitAdmissionScheduler } from '../shared/git-admission-scheduler'
import { GIT_READ_TIMEOUT_MS } from '../shared/git-command-timeout'
import {
  _resetRelayGitAdmissionForTests,
  acquireRelayGitAdmission
} from './git-handler-command-termination'
import { streamRelayGitStdout } from './git-stdout-stream'

type MockChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid?: number
}

function createChild(): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 1234
  return child
}

async function waitForSpawn(count = 1): Promise<void> {
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(count), { interval: 1 })
}

describe('streamRelayGitStdout', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    terminateMock.mockReset().mockResolvedValue(true)
    _resetRelayGitAdmissionForTests(
      new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('decodes split UTF-8 chunks and stops the child at the parser limit', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    let output = ''
    const pending = streamRelayGitStdout(['status', '--porcelain=v2'], '/repo', {
      disableOptionalLocks: true,
      onStdout: (chunk) => {
        output += chunk
        return output.includes('\n')
      }
    })
    await waitForSpawn()
    const bytes = Buffer.from('? café-😀.txt\n')
    const emojiStart = bytes.indexOf(Buffer.from('😀'))
    child.stdout.emit('data', bytes.subarray(0, emojiStart + 2))
    child.stdout.emit('data', bytes.subarray(emojiStart + 2))

    await expect(pending).resolves.toEqual({ stoppedEarly: true })
    expect(output).toBe('? café-😀.txt\n')
    expect(terminateMock).toHaveBeenCalledWith(child)
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'git',
        args: ['status', '--porcelain=v2'],
        cwd: '/repo',
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
    )
    expect(child.stdout.listenerCount('data')).toBe(0)
    child.emit('close', 0)
  })

  it('rejects parser failures after terminating and detaching the child', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const pending = streamRelayGitStdout(['status'], '/repo', {
      onStdout: () => {
        throw new Error('parser failed')
      }
    })
    await waitForSpawn()
    const rejection = expect(pending).rejects.toThrow('parser failed')
    child.stdout.emit('data', Buffer.from('? file.ts\n'))

    await rejection
    expect(terminateMock).toHaveBeenCalledWith(child)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(1)
    child.emit('close', 0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('aborts an in-flight child and rejects instead of returning partial status', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const pending = streamRelayGitStdout(['status'], '/repo', {
      signal: controller.signal,
      onStdout: () => {}
    })
    await waitForSpawn()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()

    await rejection
    expect(terminateMock).toHaveBeenCalledWith(child)
    expect(child.listenerCount('error')).toBe(1)
    child.emit('close', 0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('handles a late spawn error after abort cleanup', async () => {
    const child = createChild()
    child.pid = undefined
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const pending = streamRelayGitStdout(['status'], '/repo', {
      signal: controller.signal,
      onStdout: () => {}
    })
    await waitForSpawn()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()
    await rejection

    expect(() => child.emit('error', new Error('spawn git ENOENT'))).not.toThrow()
    expect(child.listenerCount('error')).toBe(0)
  })

  it('bounds stderr and cleans up after command failure', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const pending = streamRelayGitStdout(['status'], '/repo', {
      maxBuffer: 64,
      onStdout: () => {}
    })
    await waitForSpawn()
    const rejection = expect(pending).rejects.toThrow('git exited with 128: fatal: nope')
    child.stderr.emit('data', Buffer.from('fatal: nope'))
    child.emit('close', 128)

    await rejection
    expect(terminateMock).not.toHaveBeenCalled()
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('removes an aborted queued read without spawning it', async () => {
    const held = await acquireRelayGitAdmission({ args: ['status'], cwd: '/repo' })
    const controller = new AbortController()
    const pending = streamRelayGitStdout(['status'], '/repo', {
      signal: controller.signal,
      onStdout: () => {}
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(spawnMock).not.toHaveBeenCalled()
    held.release()
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const next = streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })
    await waitForSpawn()
    child.emit('close', 0)
    await expect(next).resolves.toEqual({ stoppedEarly: false })
  })

  it('rechecks an abort after admission before spawning', async () => {
    const controller = new AbortController()
    const pending = streamRelayGitStdout(['status'], '/repo', {
      signal: controller.signal,
      onStdout: () => {}
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
    const grant = await acquireRelayGitAdmission({ args: ['status'], cwd: '/repo' })
    grant.release()
  })

  it('returns a capped result immediately while retaining admission until child close', async () => {
    const firstChild = createChild()
    const secondChild = createChild()
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const first = streamRelayGitStdout(['status'], '/repo', { onStdout: () => true })
    await waitForSpawn()
    firstChild.stdout.emit('data', Buffer.from('? capped\n'))
    await expect(first).resolves.toEqual({ stoppedEarly: true })
    const second = streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })
    await Promise.resolve()
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(() => firstChild.stderr.emit('error', new Error('late pipe error'))).not.toThrow()
    firstChild.emit('close', null)
    await waitForSpawn(2)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    secondChild.emit('close', 0)
    await second
  })

  it.each([undefined, 25])(
    'bounds an admitted read by its default or explicit deadline: %s',
    async (timeout) => {
      vi.useFakeTimers()
      const child = createChild()
      const nextChild = createChild()
      spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(nextChild)
      const pending = streamRelayGitStdout(['status'], '/repo', { timeout, onStdout: () => {} })
      const rejection = expect(pending).rejects.toMatchObject({
        name: 'GitCommandTimeoutError',
        timedOut: true
      })
      await waitForSpawn()
      await vi.advanceTimersByTimeAsync(timeout ?? GIT_READ_TIMEOUT_MS)
      await rejection
      expect(terminateMock).toHaveBeenCalledWith(child)
      const next = streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })
      await Promise.resolve()
      expect(spawnMock).toHaveBeenCalledOnce()
      child.emit('close', null)
      await waitForSpawn(2)
      expect(spawnMock).toHaveBeenCalledTimes(2)
      nextChild.emit('close', 0)
      await next
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('retains an aborted child grant until its close', async () => {
    const child = createChild()
    const nextChild = createChild()
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(nextChild)
    const controller = new AbortController()
    const pending = streamRelayGitStdout(['status'], '/repo', {
      signal: controller.signal,
      onStdout: () => {}
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitForSpawn()
    controller.abort()
    await rejection
    const next = streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })
    await Promise.resolve()
    expect(spawnMock).toHaveBeenCalledOnce()
    child.emit('close', null)
    await waitForSpawn(2)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    nextChild.emit('close', 0)
    await next
  })

  it('releases admission on a synchronous spawn failure', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    await expect(streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })).rejects.toThrow(
      'spawn failed'
    )
    const child = createChild()
    spawnMock.mockReturnValueOnce(child)
    const next = streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })
    await waitForSpawn(2)
    child.emit('close', 0)
    await next
  })

  it('releases on confirmed asynchronous spawn failure without waiting for close', async () => {
    const child = createChild()
    child.pid = undefined
    spawnMock.mockReturnValueOnce(child)
    const pending = streamRelayGitStdout(['status'], '/repo', { onStdout: () => {} })
    const rejection = expect(pending).rejects.toThrow('ENOENT')
    await waitForSpawn()
    child.emit('error', new Error('ENOENT'))
    await rejection
    const grant = await acquireRelayGitAdmission({ args: ['status'], cwd: '/repo' })
    grant.release()
    expect(child.listenerCount('close')).toBe(0)
  })
})

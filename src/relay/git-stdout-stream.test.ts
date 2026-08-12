import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, terminateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./subprocess-tree-termination', () => ({
  terminateRelaySubprocessTree: terminateMock
}))

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

describe('streamRelayGitStdout', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    terminateMock.mockReset()
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
    const bytes = Buffer.from('? café-😀.txt\n')
    const emojiStart = bytes.indexOf(Buffer.from('😀'))
    child.stdout.emit('data', bytes.subarray(0, emojiStart + 2))
    child.stdout.emit('data', bytes.subarray(emojiStart + 2))

    await expect(pending).resolves.toEqual({ stoppedEarly: true })
    expect(output).toBe('? café-😀.txt\n')
    expect(terminateMock).toHaveBeenCalledWith(child)
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain=v2'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    )
    expect(child.stdout.listenerCount('data')).toBe(0)
  })

  it('rejects parser failures after terminating and detaching the child', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const pending = streamRelayGitStdout(['status'], '/repo', {
      onStdout: () => {
        throw new Error('parser failed')
      }
    })
    const rejection = expect(pending).rejects.toThrow('parser failed')
    child.stdout.emit('data', Buffer.from('? file.ts\n'))

    await rejection
    expect(terminateMock).toHaveBeenCalledWith(child)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
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
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()

    await rejection
    expect(terminateMock).toHaveBeenCalledWith(child)
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
    const rejection = expect(pending).rejects.toThrow('git exited with 128: fatal: nope')
    child.stderr.emit('data', Buffer.from('fatal: nope'))
    child.emit('close', 128)

    await rejection
    expect(terminateMock).not.toHaveBeenCalled()
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })
})

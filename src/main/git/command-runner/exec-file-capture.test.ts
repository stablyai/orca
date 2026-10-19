import type { ChildProcess } from 'node:child_process'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { spawnMock, signalMock, forceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
import { execFileCaptureToTermination } from './exec-file-capture'
import { ghExecFileAsync } from './gh-exec-file'
import { createGhLogicalLifetime } from './gh-capture-lifetime'

function child(): ChildProcess {
  const value = createFakeSpawnedChild()
  Object.defineProperty(value, 'pid', { value: 1234 })
  value.kill = vi.fn(() => false)
  return value
}

describe('capture overflow metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    signalMock.mockResolvedValue(false)
    forceMock.mockResolvedValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it.each([0, 1])(
    'preserves overflow on ordinary exit %s with no kill/signal through gh',
    async (code) => {
      const value = child()
      spawnMock.mockReturnValue(value)
      const owner = createGhLogicalLifetime()
      const result = ghExecFileAsync(['api', 'user'], { maxBuffer: 64 }, owner.hooks)
      const rejection = expect(result).rejects.toMatchObject({
        code,
        outputTruncated: true,
        killed: false,
        signal: null,
        stderr: 'unknown flag: --allow-escape-sequences\n'
      })
      await vi.advanceTimersByTimeAsync(0)
      value.stdout?.emit('data', Buffer.from('x'.repeat(100)))
      value.stderr?.emit('data', Buffer.from('unknown flag: --allow-escape-sequences\n'))
      value.emit('close', code, null)
      await rejection
      owner.seal()
      await owner.terminated
    }
  )
  it.each(['abort', 'timeout'])(
    'preserves overflow when %s settles after unverified grace',
    async (mode) => {
      const value = child()
      spawnMock.mockReturnValue(value)
      const controller = new AbortController()
      const result = execFileCaptureToTermination('gh', ['api', 'user'], {
        maxBuffer: 8,
        timeout: 10,
        signal: controller.signal
      })
      const rejection = expect(result).rejects.toMatchObject({
        outputTruncated: true,
        ...(mode === 'abort' ? { name: 'AbortError' } : { killed: true })
      })
      value.stdout?.emit('data', Buffer.from('x'.repeat(100)))
      if (mode === 'abort') {
        controller.abort()
      }
      await vi.advanceTimersByTimeAsync(12_010)
      await rejection
      value.emit('close', null, 'SIGKILL')
    }
  )
})

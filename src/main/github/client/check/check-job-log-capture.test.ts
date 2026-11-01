import type { ChildProcess } from 'node:child_process'
import type * as ProcessHostModule from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { startCheckJobLogDownload } from './check-job-log-download'
import fixture from './__fixtures__/gh-api-unknown-escape-flag.json'
const { spawnMock, signalMock, forceMock, captureCap } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn(),
  captureCap: { bytes: 64 }
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof ProcessHostModule>()
  return {
    ...actual,
    runProcess: (spec: Parameters<typeof actual.runProcess>[0]) =>
      actual.runProcess({ ...spec, maxOutputBytes: captureCap.bytes })
  }
})
const children: ChildProcess[] = []
function spawn(): ChildProcess {
  const child = createFakeSpawnedChild(children.length + 300)
  child.kill = vi.fn(() => false)
  children.push(child)
  return child
}
function download(controller = new AbortController(), deadlineAt = Date.now() + 25_000) {
  return startCheckJobLogDownload(
    { owner: 'acme', repo: 'widgets' },
    77,
    { signal: controller.signal, host: 'github.com', cwd: '/folder', env: {} },
    deadlineAt,
    vi.fn()
  )
}
describe('download exclusions through real process-host capture and gh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    captureCap.bytes = 64
    spawnMock.mockReset().mockImplementation(spawn)
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it.each([0, 1])(
    'does not fall back on ordinary exit %s with overflow, false killed and null signal',
    async (code) => {
      const call = download()
      const expected = expect(call.result).rejects.toMatchObject({
        code,
        outputTruncated: true,
        killed: false,
        signal: null,
        stderr: 'unknown flag: --allow-escape-sequences\n'
      })
      await vi.advanceTimersByTimeAsync(0)
      completeFakeSpawn(children[0], {
        stdout: 'x'.repeat(100),
        stderr: 'unknown flag: --allow-escape-sequences\n',
        code
      })
      await expected
      await call.terminated
      expect(children).toHaveLength(1)
    }
  )
  it.each(['abort', 'timeout'])(
    'retains overflow metadata on %s with physical termination still pending',
    async (mode) => {
      const controller = new AbortController()
      const call = download(controller, Date.now() + 10)
      const expected = expect(call.result).rejects.toMatchObject(
        mode === 'abort' ? { name: 'AbortError' } : { outputTruncated: true, killed: true }
      )
      await vi.advanceTimersByTimeAsync(0)
      children[0].stdout?.emit('data', Buffer.from('x'.repeat(100)))
      children[0].stderr?.emit('data', Buffer.from('unknown flag: --allow-escape-sequences\n'))
      if (mode === 'abort') {
        controller.abort()
      }
      await vi.advanceTimersByTimeAsync(12_010)
      if (mode === 'abort') {
        await expected
      }
      let terminated = false
      void call.terminated.then(() => {
        terminated = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(terminated).toBe(false)
      expect(children).toHaveLength(1)
      children[0].emit('close', null, 'SIGKILL')
      if (mode === 'timeout') {
        await expected
      }
      await call.terminated
    }
  )
  it('waits for an actual PID-error close before fallback, while preserving the saved exact diagnostic', async () => {
    captureCap.bytes = 4096
    const call = download()
    await vi.advanceTimersByTimeAsync(0)
    const error = Object.assign(new Error('raw message'), { code: 1, stderr: fixture.stderr })
    children[0].emit('error', error)
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    children[0].emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    expect(spawnMock.mock.calls[1][1]).not.toContain('--allow-escape-sequences')
    completeFakeSpawn(children[1], { stdout: 'recovered' })
    await expect(call.result).resolves.toBe('recovered')
    await call.terminated
  })
  it('starts no fallback when cancellation arrives during actual first-child retirement', async () => {
    captureCap.bytes = 4096
    const controller = new AbortController()
    const call = download(controller)
    const expected = expect(call.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    children[0].emit(
      'error',
      Object.assign(new Error('parser result'), { code: 1, stderr: fixture.stderr })
    )
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expected
    children[0].emit('close', 1, null)
    await call.terminated
    expect(children).toHaveLength(1)
  })
})

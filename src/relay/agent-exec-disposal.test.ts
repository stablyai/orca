import { execFile } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentExecHandler } from './agent-exec-handler'
import { RELAY_AGENT_CLOSE_DEADLINE_MS } from './relay-agent-process-lifetime'
import { createFakeChild, requestContext } from './agent-exec-handler-test-harness'
import type { MethodHandler, RelayDispatcher } from './dispatcher'

// Why an untyped mock: the fake child stubs only what AgentExecHandler reads from a ChildProcess.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn()
}))

function fixture() {
  const methods = new Map<string, MethodHandler>()
  const handler = new AgentExecHandler(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only registers request methods.
    {
      onRequest: (name: string, method: MethodHandler) => methods.set(name, method)
    } as unknown as RelayDispatcher
  )
  const exec = (params: Record<string, unknown> = {}) =>
    methods.get('agent.execNonInteractive')!(
      { binary: 'agent', timeoutMs: 1000, ...params },
      requestContext()
    )
  return { handler, exec }
}

beforeEach(() => {
  vi.useFakeTimers()
  spawnMock.mockReset()
  vi.mocked(execFile).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('waits for every child close, including commands without a cwd and replaced lanes', async () => {
  const f = fixture()
  const children = [createFakeChild(), createFakeChild(), createFakeChild()]
  for (const child of children) {
    spawnMock.mockReturnValueOnce(child)
  }
  const requests = [f.exec(), f.exec({ cwd: '/repo' }), f.exec({ cwd: '/repo' })]
  let finished = false
  const disposal = f.handler.dispose().then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  if (process.platform === 'win32') {
    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '12345', '/T', '/F'],
      expect.any(Function)
    )
  } else {
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }
  }
  children[0].emit('close', null)
  children[2].emit('close', null)
  await Promise.resolve()
  expect(finished).toBe(false)
  children[1].emit('close', null)
  await disposal
  expect(finished).toBe(true)
  await Promise.all(requests)
})

it('refuses execution once disposal begins and after it completes', async () => {
  const f = fixture()
  const child = createFakeChild()
  spawnMock.mockReturnValue(child)
  const request = f.exec()
  const disposal = f.handler.dispose()
  await expect(f.exec()).rejects.toThrow()
  expect(spawnMock).toHaveBeenCalledTimes(1)
  child.emit('close', null)
  await Promise.all([request, disposal])
  await expect(f.exec()).rejects.toThrow()
  expect(spawnMock).toHaveBeenCalledTimes(1)
})

it('retains timed-out children until close rather than treating RPC settlement as exit', async () => {
  const f = fixture()
  const child = createFakeChild()
  spawnMock.mockReturnValue(child)
  const request = f.exec({ cwd: '/repo' })
  await vi.advanceTimersByTimeAsync(1000)
  await expect(request).resolves.toMatchObject({ timedOut: true })
  let finished = false
  const disposal = f.handler.dispose().then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  child.emit('error', new Error('late child error'))
  await Promise.resolve()
  expect(finished).toBe(false)
  child.emit('close', null)
  await disposal
  expect(finished).toBe(true)
  expect(child.listenerCount('error')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
})

it('resolves disposal with no children or only already-closed children', async () => {
  await fixture().handler.dispose()
  const f = fixture()
  const child = createFakeChild()
  spawnMock.mockReturnValue(child)
  const request = f.exec()
  child.emit('close', 0)
  await request
  await f.handler.dispose()
  expect(child.kill).not.toHaveBeenCalled()
})

it('rejects within the close deadline and re-checks without re-killing on retry', async () => {
  const f = fixture()
  const child = createFakeChild()
  spawnMock.mockReturnValue(child)
  const request = f.exec({ timeoutMs: 60_000 })
  const signals = () =>
    process.platform === 'win32'
      ? vi.mocked(execFile).mock.calls.length
      : child.kill.mock.calls.length
  const first = f.handler.dispose()
  const firstOutcome = first.then(
    () => 'resolved',
    (error: Error) => error.message
  )
  expect(signals()).toBe(1)
  await vi.advanceTimersByTimeAsync(RELAY_AGENT_CLOSE_DEADLINE_MS)
  await expect(firstOutcome).resolves.toBe('relay_agent_execution_shutdown_incomplete')
  const retry = f.handler.dispose()
  expect(signals()).toBe(1)
  child.emit('close', null)
  await expect(retry).resolves.toBeUndefined()
  await request
})

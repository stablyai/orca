import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'
import type { RelayPtySourceOutput } from './relay-pty-source-output'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('./relay-pty-runtime', () => ({ bunRelayPtyModule: { spawn: mocks.mockPtySpawn } }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))

describe('source output coalescing boundaries', () => {
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  const publish = vi.fn((_id: string, _output: RelayPtySourceOutput, _interactive: boolean) => true)
  let enqueue: (id: string, data: string, meta?: Omit<RelayPtySourceOutput, 'data'>) => void

  beforeEach(() => {
    const setup = beginPtyHandlerTest(mocks)
    handler = setup.handler
    originalPlatform = setup.originalPlatform
    publish.mockReset().mockReturnValue(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the publication methods exercised by enqueue, drain and disposal.
    handler.setSourcePublication({
      accepts: () => true,
      publish,
      dispose: () => {},
      exitPublicationSettled: () => false
    } as unknown as RelayPtySourcePublication)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exercise ingress metadata boundaries directly; the production method is private only to callers.
    const ingress = handler as unknown as { enqueuePtyOutput: typeof enqueue }
    enqueue = ingress.enqueuePtyOutput.bind(handler)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('coalesces contiguous source positions but preserves discontinuities and unknown positions', async () => {
    const id = testPtyId(1)
    enqueue(id, 'ab', { seq: 2, rawLength: 2 })
    enqueue(id, 'cd', { seq: 4 })
    enqueue(id, 'e', { seq: 8 })
    enqueue(id, 'f')
    await vi.runAllTimersAsync()
    expect(publish.mock.calls.map(([, output]) => output)).toEqual([
      { data: 'abcd', seq: 4, rawLength: 4 },
      { data: 'e', seq: 8 },
      { data: 'f' }
    ])
  })

  it('does not merge ordinary entries with a non-identity raw mapping', async () => {
    const id = testPtyId(1)
    enqueue(id, 'a', { rawLength: 3, seq: 3 })
    enqueue(id, 'b', { seq: 4 })
    enqueue(id, 'c', { rawLength: 2, seq: 5 })
    await vi.runAllTimersAsync()
    expect(publish.mock.calls.map(([, output]) => output.data)).toEqual(['a', 'b', 'c'])
  })

  it('preserves transformed and zero-visible source spans as separate publications', async () => {
    const id = testPtyId(1)
    enqueue(id, 'a', { seq: 1 })
    enqueue(id, '', { transformed: true, rawLength: 7, seq: 8 })
    enqueue(id, 'b', { transformed: true, rawLength: 3, seq: 11 })
    enqueue(id, 'c', { seq: 12 })
    await vi.runAllTimersAsync()
    expect(publish.mock.calls.map(([, output]) => output)).toEqual([
      { data: 'a', seq: 1 },
      { data: '', transformed: true, rawLength: 7, seq: 8 },
      { data: 'b', transformed: true, rawLength: 3, seq: 11 },
      { data: 'c', seq: 12 }
    ])
  })

  it('retries the identical reserved object before publishing later ingress', async () => {
    const id = testPtyId(1)
    publish.mockReturnValue(false)
    enqueue(id, 'first', { seq: 5 })
    await vi.advanceTimersByTimeAsync(8)
    const reserved = publish.mock.calls[0][1]
    enqueue(id, 'next', { seq: 9 })
    publish.mockReturnValue(true)
    handler.handleSourcePublicationCapacity(id)
    await vi.runAllTimersAsync()
    expect(publish.mock.calls[1][1]).toBe(reserved)
    expect(publish.mock.calls[2][1]).toEqual({ data: 'next', seq: 9 })
  })

  it('caps coalesced entries and rotates to another terminal before draining a remainder', async () => {
    const first = testPtyId(1)
    const second = testPtyId(2)
    const chunk = 'a'.repeat(32 * 1024)
    enqueue(first, chunk)
    enqueue(first, chunk)
    enqueue(first, 'tail')
    enqueue(second, 'interactive')
    await vi.advanceTimersByTimeAsync(1)
    expect(publish.mock.calls.map(([id, output]) => [id, output.data.length])).toEqual([
      [first, 64 * 1024],
      [second, 11]
    ])
    await vi.advanceTimersByTimeAsync(1)
    expect(publish.mock.calls[2][1]).toEqual({ data: 'tail' })
  })
})

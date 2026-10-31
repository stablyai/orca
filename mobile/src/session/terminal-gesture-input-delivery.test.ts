import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import type { ConnectionState } from '../transport/types'

vi.mock('../terminal/mobile-terminal-operations', () => ({
  terminalInputSend: {
    request: vi.fn(),
    interpret: (response: { result: { send: { accepted: boolean } } }) =>
      response.result.send.accepted
  },
  terminalBufferClear: {}
}))

const handle = 'term-gesture'
const up = '\x1b[A'
const down = '\x1b[B'
const ref = <T>(current: T) => ({ current })
const request = vi.mocked(terminalInputSend.request)
const renderers: ReactTestRenderer[] = []
const accepted: Awaited<ReturnType<typeof terminalInputSend.request>> = {
  id: 'synthetic-rpc',
  ok: true,
  result: { send: { accepted: true } }
}

function fixture() {
  const client = {}
  const scope = {
    client,
    clientRef: ref<object | null>(client),
    connState: 'connected',
    connStateRef: ref<ConnectionState>('connected'),
    activeHandle: handle,
    activeHandleRef: ref<string | null>(handle),
    activeSessionTabTypeRef: ref<string | null>('terminal'),
    ptyModesRef: ref(new Map([[handle, { altScreen: true }]])),
    terminalGestureInputBucketsRef: ref(new Map()),
    terminalGestureInputQueuesRef: ref(new Map()),
    terminalGestureInputInFlightRef: ref(new Set()),
    deviceTokenRef: ref('synthetic-device')
  }
  let actions!: ReturnType<typeof useMobileSessionTerminalInput>
  function Harness() {
    actions = useMobileSessionTerminalInput(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field reached by the gesture path; unrelated controller capabilities are not invoked.
      scope as unknown as Parameters<typeof useMobileSessionTerminalInput>[0]
    )
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  return { actions, scope }
}

function holdFirstRequest() {
  let release!: () => void
  const pending = new Promise<typeof accepted>((resolve) => {
    release = () => resolve(accepted)
  })
  request.mockReturnValueOnce(pending)
  return release
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  request.mockReset()
  request.mockResolvedValue(accepted)
})
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('sends the first scroll input without waiting for a timer', async () => {
  const { actions } = fixture()
  await actions.handleTerminalInput(handle, up)
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ terminal: handle, text: up, enter: false }),
    expect.anything()
  )
})

it('keeps one request in flight and drains later movement in order after its acknowledgement', async () => {
  const release = holdFirstRequest()
  const { actions } = fixture()
  await actions.handleTerminalInput(handle, up)
  await actions.handleTerminalInput(handle, down)
  await actions.handleTerminalInput(handle, up)
  expect(request).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(16)
  expect(request).toHaveBeenCalledTimes(1)
  release()
  await settle()
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({ text: up }),
    expect.objectContaining({ text: down + up })
  ])
})

it.each(['disconnected', 'inactive', 'expired'] as const)(
  'drops queued movement that becomes %s before the preceding request settles',
  async (reason) => {
    const release = holdFirstRequest()
    const { actions, scope } = fixture()
    await actions.handleTerminalInput(handle, up)
    await actions.handleTerminalInput(handle, down)
    if (reason === 'disconnected') {
      scope.connStateRef.current = 'reconnecting'
    }
    if (reason === 'inactive') {
      scope.activeHandleRef.current = 'another-terminal'
    }
    if (reason === 'expired') {
      await vi.advanceTimersByTimeAsync(251)
    }
    release()
    await settle()
    expect(request).toHaveBeenCalledTimes(1)
    expect(scope.terminalGestureInputQueuesRef.current.size).toBe(0)
  }
)

it('retains gesture validation and the per-sequence rate limit', async () => {
  const release = holdFirstRequest()
  const { actions } = fixture()
  await actions.handleTerminalInput(handle, 'plain text')
  await actions.handleTerminalInput('another-terminal', up)
  expect(request).not.toHaveBeenCalled()
  await actions.handleTerminalInput(handle, up.repeat(32))
  await actions.handleTerminalInput(handle, down.repeat(32))
  await actions.handleTerminalInput(handle, up)
  expect(request).toHaveBeenCalledTimes(1)
  release()
  await settle()
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ text: down.repeat(32) }))
})

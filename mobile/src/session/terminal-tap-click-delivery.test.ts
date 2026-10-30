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
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))

const handle = 'term-tap'
const up = '\x1b[A'
const down = '\x1b[B'
const click = '\x1b[<0;9;31M\x1b[<0;9;31m'
const ref = <T>(current: T) => ({ current })
const request = vi.mocked(terminalInputSend.request)
const renderers: ReactTestRenderer[] = []
const accepted: Awaited<ReturnType<typeof terminalInputSend.request>> = {
  id: 'synthetic-rpc',
  ok: true,
  result: { send: { accepted: true } }
}

function fixture(liveField: boolean) {
  const client = {}
  const sendLiveInputClick = vi.fn(async () => true)
  const sendLiveTerminalInput = vi.fn(async () => true)
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
    deviceTokenRef: ref('synthetic-device'),
    liveInputTerminalHandlesRef: ref(new Set(liveField ? [handle] : [])),
    sendLiveInputClick,
    sendLiveTerminalInputRef: ref(sendLiveTerminalInput)
  }
  let actions!: ReturnType<typeof useMobileSessionTerminalInput>
  function Harness() {
    actions = useMobileSessionTerminalInput(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field reached by the gesture and click paths; unrelated controller capabilities are not invoked.
      scope as unknown as Parameters<typeof useMobileSessionTerminalInput>[0]
    )
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  return { actions, sendLiveInputClick, sendLiveTerminalInput }
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

it('sends a tap click through the live field queue even after a fling drained the bucket', async () => {
  const release = holdFirstRequest()
  const { actions, sendLiveInputClick } = fixture(true)
  await actions.handleTerminalInput(handle, up.repeat(32))
  await actions.handleTerminalInput(handle, down.repeat(32))
  await actions.handleTerminalInput(handle, click, { click: true })
  expect(sendLiveInputClick).toHaveBeenCalledWith(handle, click)
  release()
  await settle()
  await vi.advanceTimersByTimeAsync(16)
  expect(request.mock.calls.map((call) => call[1])).not.toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('[<0;') })
  )
})

it('sends a click at once for a terminal without the live field, past a wheel in flight', async () => {
  const release = holdFirstRequest()
  const { actions, sendLiveInputClick, sendLiveTerminalInput } = fixture(false)
  await actions.handleTerminalInput(handle, up)
  await vi.advanceTimersByTimeAsync(16)
  expect(request).toHaveBeenCalledTimes(1)
  await actions.handleTerminalInput(handle, click, { click: true })
  await vi.advanceTimersByTimeAsync(300)
  expect(sendLiveTerminalInput).toHaveBeenCalledWith(handle, click, 'pointer')
  expect(sendLiveInputClick).not.toHaveBeenCalled()
  release()
  await settle()
  expect(request).toHaveBeenCalledTimes(1)
})

it('keeps the gesture validation in front of a click', async () => {
  const { actions, sendLiveInputClick, sendLiveTerminalInput } = fixture(false)
  await actions.handleTerminalInput(handle, 'plain text', { click: true })
  await actions.handleTerminalInput('another-terminal', click, { click: true })
  await vi.advanceTimersByTimeAsync(16)
  expect(sendLiveTerminalInput).not.toHaveBeenCalled()
  expect(sendLiveInputClick).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})

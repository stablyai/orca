import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROCESS_BOUNDARY_GROUND } from '../shared/terminal-mode-reset-profiles'
import { RelayDispatcher, type RelayClientSessionIdentity } from '../wsl-guest/dispatcher'
import { encodeJsonRpcFrame, MessageType } from '../wsl-guest/protocol'
import { PtyHandler } from './pty-handler'
import { TEST_PTY_ID_MINT_EPOCH } from './pty-handler-test-harness'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const { mockPtySpawn, mockConfirmShellForeground } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockConfirmShellForeground: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/daemon/pty-subprocess/pty-shell-foreground-confirmation', () => ({
  confirmPtyShellForeground: mockConfirmShellForeground
}))

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

// A command that pushed kitty keyboard flags and died without popping them.
const DYING_COMMAND = '\x1b]133;C\x07\x1b[>1u'
const COMMAND_DONE = '\x1b]133;D;130\x07'
const PROMPT = '$ '

type Frame = {
  method?: string
  id?: number
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

function decode(buffer: Buffer): Frame | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  return JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
}

describe.each([
  ['source-credit delivery', true],
  ['legacy delivery', false]
])('PtyHandler shell recovery over %s', (_, sourceCredit) => {
  let dispatcher: RelayDispatcher
  let handler: PtyHandler
  let writes: Buffer[]
  let emitData: (data: string) => void
  let emitExit: (event: { exitCode: number }) => void
  let ptyId: string
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(async () => {
    vi.useFakeTimers()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    writes = []
    mockConfirmShellForeground.mockReset()
    mockPtySpawn.mockReset()
    mockPtySpawn.mockReturnValue({
      pid: process.pid,
      onData: vi.fn((callback: (data: string) => void) => (emitData = callback)),
      onExit: vi.fn((callback: (event: { exitCode: number }) => void) => (emitExit = callback)),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn()
    })
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        writes.push(Buffer.from(data))
        queueMicrotask(() => settle({ ok: true }))
        return true
      },
      { supportsWriteCallback: true, writableHighWaterMark: () => 0 },
      endpointIdentity
    )
    handler = new PtyHandler(dispatcher, undefined, TEST_PTY_ID_MINT_EPOCH)
    if (sourceCredit) {
      let publication: RelayPtySourcePublication | undefined
      const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
        publication?.onCreditAvailable(id)
      )
      publication = new RelayPtySourcePublication(dispatcher, adapter, (id) =>
        handler.handleSourcePublicationCapacity(id)
      )
      handler.setSourcePublication(publication)
      dispatcher.feed(
        requestFrame(1, 'pty.openClient', {
          protocolVersion: 1,
          clientInstanceId: 'client-1',
          requestedRole: 'session-owner',
          capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 256 * 1024 } }
        })
      )
      await vi.advanceTimersByTimeAsync(0)
    }
    dispatcher.feed(requestFrame(2, 'pty.spawn', {}))
    await vi.advanceTimersByTimeAsync(0)
    ptyId = String(response(2)?.id)
  })

  afterEach(async () => {
    await handler.dispose({ waitForPhysicalExit: false }).catch(() => {})
    dispatcher.dispose()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    vi.useRealTimers()
  })

  function response(id: number): Record<string, unknown> | undefined {
    return writes.map(decode).find((frame) => frame?.id === id)?.result
  }

  function published(): string {
    const frames = writes.map(decode).filter((frame) => frame?.method === 'pty.data')
    if (sourceCredit) {
      expect(frames.every((frame) => frame?.params?.sourceLengthSu !== undefined)).toBe(true)
    }
    return frames.map((frame) => frame?.params?.data).join('')
  }

  async function replay(): Promise<string> {
    dispatcher.feed(
      requestFrame(3, 'pty.attach', {
        id: ptyId,
        requireReplay: true,
        suppressReplayNotification: true
      })
    )
    await vi.advanceTimersByTimeAsync(0)
    return String(response(3)?.replay ?? '')
  }

  async function stream(...chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      emitData(chunk)
    }
    await vi.advanceTimersByTimeAsync(50)
  }

  it('grounds a dead command before the prompt, live and in replay alike', async () => {
    mockConfirmShellForeground.mockResolvedValue(true)
    await stream(DYING_COMMAND, `${COMMAND_DONE}${PROMPT}`)

    const expected = `${DYING_COMMAND}${COMMAND_DONE}${PROCESS_BOUNDARY_GROUND}${PROMPT}`
    expect(mockConfirmShellForeground).toHaveBeenCalledOnce()
    expect(published()).toBe(expected)
    expect(await replay()).toBe(expected)
  })

  it('leaves the bytes unchanged when the shell does not own the foreground', async () => {
    mockConfirmShellForeground.mockResolvedValue(false)
    await stream(DYING_COMMAND, `${COMMAND_DONE}${PROMPT}`)

    const expected = `${DYING_COMMAND}${COMMAND_DONE}${PROMPT}`
    expect(published()).toBe(expected)
    expect(await replay()).toBe(expected)
  })

  it('delivers a dying app’s oversized final frame and the ground behind it', async () => {
    mockConfirmShellForeground.mockResolvedValue(true)
    const finalFrame = 'x'.repeat(20 * 1024)
    await stream(DYING_COMMAND, `${finalFrame}${COMMAND_DONE}${PROMPT}`)

    const expected = `${DYING_COMMAND}${finalFrame}${COMMAND_DONE}${PROCESS_BOUNDARY_GROUND}${PROMPT}`
    expect(published()).toBe(expected)
    expect(await replay()).toBe(expected)
  })

  it('flushes the held prompt when the shell exits mid-proof', async () => {
    mockConfirmShellForeground.mockReturnValue(new Promise(() => {}))
    await stream(DYING_COMMAND, `${COMMAND_DONE}${PROMPT}`)
    expect(published()).not.toContain(PROMPT)

    emitExit({ exitCode: 0 })
    await vi.advanceTimersByTimeAsync(50)

    expect(published()).toBe(`${DYING_COMMAND}${COMMAND_DONE}${PROMPT}`)
  })

  it('grounds replay, not the live stream, on Reset Terminal after an unhooked crash', async () => {
    // Armed with no command end: nothing the host barrier could ground at.
    const unhookedCrash = '\x1b[>1u\x1b[?1000h'
    await stream(unhookedCrash, PROMPT)

    dispatcher.feed(requestFrame(4, 'pty.resetInputModes', { id: ptyId }))
    await vi.advanceTimersByTimeAsync(50)

    // The client grounds its own view; a zero-raw span would not cross the credit window.
    expect(published()).toBe(`${unhookedCrash}${PROMPT}`)
    expect(await replay()).toBe(`${unhookedCrash}${PROMPT}${PROCESS_BOUNDARY_GROUND}`)
  })
})

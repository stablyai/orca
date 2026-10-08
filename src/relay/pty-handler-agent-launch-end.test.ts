import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { encodeJsonRpcFrame } from './protocol'
import { PtyHandler } from './pty-handler'
import { TEST_PTY_ID_MINT_EPOCH } from './pty-handler-test-harness'
import { makePaneKey } from '../shared/stable-pane-id'

const { mockPtySpawn } = vi.hoisted(() => ({ mockPtySpawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

const identity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}
const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const COMMAND_DONE = '\x1b]133;C\x07\x1b]133;D;0\x07$ '

describe('PtyHandler: a launched agent command finishing', () => {
  let dispatcher: RelayDispatcher
  let handler: PtyHandler
  let emitData: (data: string) => void
  let launchEnd: ReturnType<typeof vi.fn<(paneKey: string, agent: string) => void>>
  let presence: ReturnType<typeof vi.fn<(paneKey: string) => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    mockPtySpawn.mockReset()
    mockPtySpawn.mockReturnValue({
      pid: process.pid,
      onData: vi.fn((callback: (data: string) => void) => (emitData = callback)),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn()
    })
    dispatcher = new RelayDispatcher(
      (_data, settle) => {
        queueMicrotask(() => settle({ ok: true }))
        return true
      },
      { supportsWriteCallback: true, writableHighWaterMark: () => 0 },
      identity
    )
    handler = new PtyHandler(dispatcher, undefined, TEST_PTY_ID_MINT_EPOCH)
    launchEnd = vi.fn()
    presence = vi.fn()
    handler.setAgentLaunchEndListener(launchEnd)
    handler.setAgentPresenceTrigger(presence)
  })

  afterEach(async () => {
    await handler.dispose({ waitForPhysicalExit: false }).catch(() => {})
    dispatcher.dispose()
    vi.useRealTimers()
  })

  async function spawn(params: Record<string, unknown>): Promise<void> {
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'pty.spawn',
          params: { env: { ORCA_PANE_KEY: paneKey }, ...params }
        },
        1,
        0
      )
    )
    await vi.advanceTimersByTimeAsync(0)
  }

  it('ends the launch once, on its first command finish, and rechecks every time', async () => {
    await spawn({ launchAgent: 'codex' })
    emitData(COMMAND_DONE)
    emitData(COMMAND_DONE)
    expect(launchEnd.mock.calls).toEqual([[paneKey, 'codex']])
    expect(presence).toHaveBeenCalledTimes(2)
  })

  it('ends nothing in a pane Orca launched no agent in', async () => {
    await spawn({})
    emitData(COMMAND_DONE)
    expect(launchEnd).not.toHaveBeenCalled()
    expect(presence).toHaveBeenCalledOnce()
  })
})

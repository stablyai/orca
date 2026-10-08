import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { encodeJsonRpcFrame } from './protocol'
import { PtyHandler } from './pty-handler'
import { TEST_PTY_ID_MINT_EPOCH } from './pty-handler-test-harness'
import { makePaneKey } from '../shared/stable-pane-id'
import type * as PtyShellUtils from './pty-shell-utils'
import type { FinishedCommand } from '../shared/command-foreground-tracker'

const { mockPtySpawn, foreground } = vi.hoisted(() => {
  const current: { current: string | null } = { current: 'zsh' }
  return { mockPtySpawn: vi.fn(), foreground: current }
})
vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('./pty-shell-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof PtyShellUtils>()),
  getForegroundProcessName: vi.fn(async () => foreground.current)
}))

const identity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}
const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const COMMAND_START = '\x1b]133;C\x07'
const COMMAND_DONE = '\x1b]133;D;0\x07$ '

describe('PtyHandler: a command finishing', () => {
  let dispatcher: RelayDispatcher
  let handler: PtyHandler
  let emitData: (data: string) => void
  let commandEnd: ReturnType<typeof vi.fn<(paneKey: string, command: FinishedCommand) => void>>
  let presence: ReturnType<typeof vi.fn<(paneKey: string) => void>>
  // node-pty's read of the terminal's foreground group.
  let pty: { process: string }

  beforeEach(() => {
    vi.useFakeTimers()
    mockPtySpawn.mockReset()
    pty = { process: 'bash' }
    mockPtySpawn.mockReturnValue({
      get process() {
        return pty.process
      },
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
    commandEnd = vi.fn()
    foreground.current = 'zsh'
    presence = vi.fn()
    handler.setAgentCommandEndListener(commandEnd)
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

  it('reports the agent its command ran in the foreground, and rechecks the owner', async () => {
    await spawn({})
    emitData(COMMAND_START)
    foreground.current = 'codex'
    // Why: the relay reads on live reports only; an agent report during the command reads Codex.
    handler.observeAgentActivity(paneKey)
    await vi.advanceTimersByTimeAsync(0)
    foreground.current = 'zsh'
    emitData(COMMAND_DONE)
    await vi.advanceTimersByTimeAsync(0)
    expect(commandEnd).toHaveBeenCalledOnce()
    expect(commandEnd.mock.calls[0]).toEqual([
      paneKey,
      expect.objectContaining({ foreground: { kind: 'agent', agent: 'codex' } })
    ])
    expect(presence).toHaveBeenCalledOnce()
  })

  it("confirms the prompt returned from the terminal's own group, not the cached sampler", async () => {
    await spawn({})
    emitData(COMMAND_START)
    // A nested shell's leaked end while Codex still holds the terminal.
    pty.process = 'codex'
    emitData(COMMAND_DONE)
    await vi.advanceTimersByTimeAsync(0)
    await expect(commandEnd.mock.calls[0]?.[1].promptReturned()).resolves.toBe(false)
    // Codex exited: the cached sampler may still name it, the terminal does not.
    foreground.current = 'codex'
    pty.process = 'bash'
    emitData(COMMAND_START)
    emitData(COMMAND_DONE)
    await vi.advanceTimersByTimeAsync(0)
    await expect(commandEnd.mock.calls[1]?.[1].promptReturned()).resolves.toBe(true)
  })
})

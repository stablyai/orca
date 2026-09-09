import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'
import { agentSessionPtyWriteGate } from '../../../runtime/agent-session-pty-write-gate'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const PTY_ID = 'pty-chunk-yield'

const { provider } = vi.hoisted(() => ({ provider: { write: vi.fn() } }))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

const realSetImmediate = globalThis.setImmediate
const realReadmit = agentSessionPtyWriteGate.readmit.bind(agentSessionPtyWriteGate)
const THREE_CHUNK_INPUT = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8)

const mainWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() }
}

/** Resolves after `turns` real check-phase passes; never touches the (faked) timer queue. */
function afterImmediateTurns(turns: number): Promise<'stalled'> {
  return new Promise((resolve) => {
    const step = (remaining: number): void => {
      if (remaining === 0) {
        resolve('stalled')
        return
      }
      realSetImmediate(() => step(remaining - 1))
    }
    step(turns)
  })
}

function createWriteInput(): ReturnType<typeof createPtyWriteInput>['writePtyInput'] {
  return createPtyWriteInput({
    mainWindow: mainWindow as never,
    clearHiddenRendererResizeOutput: vi.fn()
  }).writePtyInput
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, null)
  provider.write.mockReset()
  mainWindow.webContents.send.mockReset()
  // Why: only setTimeout is faked. A setTimeout(0) yield would stall the write forever here,
  // while a setImmediate yield still runs in Node's check phase — the race below is deterministic.
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})

afterEach(() => {
  ptyOwnership.delete(PTY_ID)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('chunked pty write yield', () => {
  it('yields between chunks via setImmediate, not a timer, and readmits before each later chunk', async () => {
    const events: string[] = []
    provider.write.mockImplementation((_id: string, data: string) => {
      events.push(`write:${data.length}`)
    })
    vi.spyOn(agentSessionPtyWriteGate, 'readmit').mockImplementation((...args) => {
      events.push('readmit')
      return realReadmit(...args)
    })
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: () => void) => {
      events.push('yield')
      return realSetImmediate(callback)
    }) as typeof setImmediate)

    const outcome = await Promise.race([
      createWriteInput()({ id: PTY_ID, data: THREE_CHUNK_INPUT }),
      afterImmediateTurns(50)
    ])

    expect(outcome).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(events).toEqual([
      `write:${TERMINAL_INPUT_CHUNK_MAX_BYTES}`,
      'yield',
      'readmit',
      `write:${TERMINAL_INPUT_CHUNK_MAX_BYTES}`,
      'yield',
      'readmit',
      'write:8'
    ])
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('does not yield for input that fits in a single chunk', async () => {
    const immediate = vi.spyOn(globalThis, 'setImmediate')

    const outcome = createWriteInput()({
      id: PTY_ID,
      data: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    })

    expect(outcome).toBe(true)
    expect(provider.write).toHaveBeenCalledTimes(1)
    expect(immediate).not.toHaveBeenCalled()
  })

  it('stops after a yield once readmission refuses', async () => {
    const readmit = vi.spyOn(agentSessionPtyWriteGate, 'readmit').mockReturnValue({
      admitted: false,
      refusal: {
        code: 'agent_session_checkpoint_stale',
        sessionId: 'session-1',
        ownerRuntimeKind: null,
        handoffStage: null,
        ownerPid: null,
        runtimeFence: null
      }
    })

    const outcome = await Promise.race([
      createWriteInput()({ id: PTY_ID, data: THREE_CHUNK_INPUT }),
      afterImmediateTurns(50)
    ])

    expect(outcome).toBe(false)
    expect(provider.write).toHaveBeenCalledTimes(1)
    expect(readmit).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'pty:writeUnavailable',
      expect.objectContaining({ id: PTY_ID })
    )
  })
})

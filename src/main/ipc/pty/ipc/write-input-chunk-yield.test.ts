import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const PTY_ID = 'pty-chunk-yield'

const { provider } = vi.hoisted(() => ({ provider: { write: vi.fn() } }))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

const realSetImmediate = globalThis.setImmediate
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: write input only calls isDestroyed() and webContents, which this mock provides.
    mainWindow: mainWindow as never
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
  it('yields between chunks via setImmediate, not a timer', async () => {
    const events: string[] = []
    provider.write.mockImplementation((_id: string, data: string) => {
      events.push(`write:${data.length}`)
    })
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: () => void) => {
      events.push('yield')
      return realSetImmediate(callback)
    }) as typeof setImmediate)

    const outcome = await Promise.race([
      createWriteInput()({ inputKind: 'driving', id: PTY_ID, data: THREE_CHUNK_INPUT }),
      afterImmediateTurns(50)
    ])

    expect(outcome).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(events).toEqual([
      `write:${TERMINAL_INPUT_CHUNK_MAX_BYTES}`,
      'yield',
      `write:${TERMINAL_INPUT_CHUNK_MAX_BYTES}`,
      'yield',
      'write:8'
    ])
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('does not yield for input that fits in a single chunk', async () => {
    const immediate = vi.spyOn(globalThis, 'setImmediate')

    const outcome = createWriteInput()({
      inputKind: 'driving',
      id: PTY_ID,
      data: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    })

    expect(outcome).toBe(true)
    expect(provider.write).toHaveBeenCalledTimes(1)
    expect(immediate).not.toHaveBeenCalled()
  })
})

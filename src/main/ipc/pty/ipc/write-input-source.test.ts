import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const PTY_ID = 'pty-input-source'

const { provider } = vi.hoisted(() => ({ provider: { write: vi.fn() } }))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

const mainWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() }
}

function makeRuntime(driverKind: 'desktop' | 'mobile') {
  return {
    getDriver: vi.fn(() => ({ kind: driverKind })),
    recordTerminalInputSource: vi.fn()
  }
}

function createWriteInput(runtime: ReturnType<typeof makeRuntime>) {
  return createPtyWriteInput({
    mainWindow: mainWindow as never,
    runtime: runtime as never,
    clearHiddenRendererResizeOutput: vi.fn()
  })
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, null)
  provider.write.mockReset()
})

afterEach(() => {
  ptyOwnership.delete(PTY_ID)
  vi.restoreAllMocks()
})

describe('renderer pty:write records a local input source', () => {
  it('records once a single-chunk write went through', () => {
    const runtime = makeRuntime('desktop')
    const outcome = createWriteInput(runtime).writePtyInput({ id: PTY_ID, data: 'ls\r' })

    expect(outcome).toBe(true)
    expect(runtime.recordTerminalInputSource).toHaveBeenCalledWith(PTY_ID, {})
  })

  it('records after a chunked write settles, and only once', async () => {
    const runtime = makeRuntime('desktop')
    const pending = createWriteInput(runtime).writePtyInput({
      id: PTY_ID,
      data: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8)
    })

    expect(runtime.recordTerminalInputSource).not.toHaveBeenCalled()
    await expect(pending).resolves.toBe(true)
    expect(runtime.recordTerminalInputSource).toHaveBeenCalledTimes(1)
    expect(runtime.recordTerminalInputSource).toHaveBeenCalledWith(PTY_ID, {})
  })

  it('records nothing for a write the mobile presence lock refused', () => {
    const runtime = makeRuntime('mobile')
    const outcome = createWriteInput(runtime).writePtyInput({ id: PTY_ID, data: 'ls\r' })

    expect(outcome).toBe(false)
    expect(provider.write).not.toHaveBeenCalled()
    expect(runtime.recordTerminalInputSource).not.toHaveBeenCalled()
  })

  it('records nothing through the accepted variant when the provider throws', () => {
    const runtime = makeRuntime('desktop')
    provider.write.mockImplementation(() => {
      throw new Error('boom')
    })

    const outcome = createWriteInput(runtime).writePtyInputAccepted({ id: PTY_ID, data: 'ls' })

    expect(outcome).toBe(false)
    expect(runtime.recordTerminalInputSource).not.toHaveBeenCalled()
  })
})

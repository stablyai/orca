import { describe, expect, it, vi } from 'vitest'
import { sendTerminalStreamInput } from './terminal-input-delivery'
import type { OrcaRuntimeService } from '../../../orca-runtime'

function makeRuntime(accepted: boolean) {
  const recordTerminalInputSource = vi.fn()
  const runtime = {
    sendTerminal: vi.fn(async () => ({ accepted, bytesWritten: accepted ? 1 : 0 })),
    beginMobileInputFloor: vi.fn(() => ({ commit: vi.fn(), rollback: vi.fn() })),
    recordTerminalInputSource
  }
  return { runtime: runtime as unknown as OrcaRuntimeService, recordTerminalInputSource }
}

describe('sendTerminalStreamInput input source', () => {
  it('records the caller against the PTY once a desktop write is accepted', async () => {
    const { runtime, recordTerminalInputSource } = makeRuntime(true)
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: 'term-1',
      ptyId: 'pty-1',
      text: 'ls\r',
      client: { id: 'desktop-1', type: 'desktop' },
      isMobile: false,
      caller: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
    expect(outcome).toBe('delivered')
    expect(recordTerminalInputSource).toHaveBeenCalledWith('pty-1', {
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    })
  })

  it('records the caller for a mobile write that took the input floor', async () => {
    const { runtime, recordTerminalInputSource } = makeRuntime(true)
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: 'term-1',
      ptyId: 'pty-1',
      text: 'y',
      client: { id: 'phone-1', type: 'mobile' },
      isMobile: true,
      caller: { pairedDeviceId: 'device-phone', clientKind: 'mobile' }
    })
    expect(outcome).toBe('delivered')
    expect(recordTerminalInputSource).toHaveBeenCalledWith('pty-1', {
      pairedDeviceId: 'device-phone',
      clientKind: 'mobile'
    })
  })

  it('records nothing when the PTY refused the write', async () => {
    const { runtime, recordTerminalInputSource } = makeRuntime(false)
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: 'term-1',
      ptyId: 'pty-1',
      text: 'ls\r',
      client: { id: 'desktop-1', type: 'desktop' },
      isMobile: false,
      caller: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
    expect(outcome).toBe('rejected')
    expect(recordTerminalInputSource).not.toHaveBeenCalled()
  })
})

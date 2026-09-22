import { describe, expect, it, vi } from 'vitest'
import { sendTerminalStreamInput } from './terminal-input-delivery'
import type { OrcaRuntimeService } from '../../../orca-runtime'

function makeRuntime(accepted: boolean) {
  const sendTerminal = vi.fn(
    async (_handle: string, _action: unknown, _options?: Record<string, unknown>) => ({
      accepted,
      bytesWritten: accepted ? 1 : 0
    })
  )
  const runtime = {
    sendTerminal,
    beginMobileInputFloor: vi.fn(() => ({ commit: vi.fn(), rollback: vi.fn() }))
  }
  return { runtime: runtime as unknown as OrcaRuntimeService, sendTerminal }
}

describe('sendTerminalStreamInput input source', () => {
  it('hands the caller to the runtime write for a desktop stream', async () => {
    const { runtime, sendTerminal } = makeRuntime(true)
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: 'term-1',
      text: 'ls\r',
      client: { id: 'desktop-1', type: 'desktop' },
      isMobile: false,
      inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
    expect(outcome).toBe('delivered')
    expect(sendTerminal.mock.calls[0]?.[2]).toEqual({
      inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
  })

  it('hands the caller to the runtime write for a mobile stream that takes the floor', async () => {
    const { runtime, sendTerminal } = makeRuntime(true)
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: 'term-1',
      text: 'y',
      client: { id: 'phone-1', type: 'mobile' },
      isMobile: true,
      inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' }
    })
    expect(outcome).toBe('delivered')
    expect(sendTerminal.mock.calls[0]?.[2]).toMatchObject({
      inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' },
      reserveWrite: expect.any(Function),
      afterWrite: expect.any(Function)
    })
  })

  it('reports a refused write as rejected', async () => {
    const { runtime } = makeRuntime(false)
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: 'term-1',
      text: 'ls\r',
      client: { id: 'desktop-1', type: 'desktop' },
      isMobile: false,
      inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
    expect(outcome).toBe('rejected')
  })
})

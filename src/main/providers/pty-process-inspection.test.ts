import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './pty-provider-contract'
import {
  inspectPtyProviderProcess,
  inspectPtyProviderProcessForRenderer
} from './pty-process-inspection'

describe('PTY provider process inspection', () => {
  it('rejects a missing provider PTY instead of returning idle evidence', async () => {
    const provider = {
      hasPty: vi.fn(() => false),
      getForegroundProcess: vi.fn().mockResolvedValue(null),
      hasChildProcesses: vi.fn().mockResolvedValue(false)
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcess(provider, 'pty-missing')).rejects.toThrow(
      'terminal_gone'
    )
    expect(provider.getForegroundProcess).not.toHaveBeenCalled()
  })

  it('returns client-only unverifiable to the renderer when a stale PTY is gone', async () => {
    const provider = {
      hasPty: vi.fn(() => false)
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcessForRenderer(provider, 'pty-missing')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'terminal_gone'
    })
  })

  it('preserves non-stale renderer inspection failures', async () => {
    const failure = new Error('daemon unavailable')
    const provider = {
      inspectProcess: vi.fn().mockRejectedValue(failure)
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcessForRenderer(provider, 'pty-1')).rejects.toBe(failure)
  })

  it('returns client-only unverifiable when the provider loses transport', async () => {
    const provider = {
      inspectProcess: vi.fn().mockRejectedValue(new Error('SSH connection lost, reconnecting...'))
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcessForRenderer(provider, 'pty-1')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'transport_loss'
    })
  })
})

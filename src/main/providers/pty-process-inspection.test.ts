import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './types'
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

  it('preserves a completion-sensitive provider failure', async () => {
    const failure = new Error('daemon unavailable')
    const inspectProcess = vi.fn().mockRejectedValue(failure)
    const provider = { inspectProcess } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcess(provider, 'pty-1')).rejects.toBe(failure)
    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
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

  it('preserves a client-only unverifiable inspection result', async () => {
    const inspection = {
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable' as const,
      reason: 'transport_loss' as const
    }
    const inspectProcess = vi.fn().mockResolvedValue(inspection)
    const provider = { inspectProcess } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcess(provider, 'pty-1')).resolves.toEqual(inspection)
  })

  it('falls back to the existing provider process APIs', async () => {
    const getForegroundProcess = vi.fn().mockResolvedValue('codex')
    const hasChildProcesses = vi.fn().mockResolvedValue(true)
    const provider = {
      getForegroundProcess,
      hasChildProcesses
    } as Pick<IPtyProvider, 'getForegroundProcess' | 'hasChildProcesses'> as IPtyProvider

    await expect(inspectPtyProviderProcess(provider, 'pty-1')).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
  })
})

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

  it('returns unavailable to the renderer for a provider that cannot vouch for the absence', async () => {
    const provider = {
      hasPty: vi.fn(() => false)
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcessForRenderer(provider, 'pty-missing')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: 'no provider could route to this PTY' },
        children: { verdict: 'unverifiable', reason: 'no provider could route to this PTY' }
      }
    })
  })

  it('publishes a watched local exit as exited, with no unavailable marker', async () => {
    const provider = {
      hasPty: vi.fn(() => false),
      ptyAbsenceVerdict: vi.fn(() => 'exited' as const)
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcessForRenderer(provider, 'pty-exited')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: null },
        children: { verdict: 'exited' }
      }
    })
  })

  it('publishes a lost route as unverifiable, never as an exit', async () => {
    const provider = {
      hasPty: vi.fn(() => false),
      ptyAbsenceVerdict: vi.fn(() => 'unverifiable' as const)
    } as unknown as IPtyProvider

    const result = await inspectPtyProviderProcessForRenderer(provider, 'pty-unrouted')

    expect(result.unavailable).toBe(true)
    expect(result.processEvidence?.children.verdict).toBe('unverifiable')
  })

  it('keeps an untyped terminal_gone unverifiable', async () => {
    const provider = {
      inspectProcess: vi.fn().mockRejectedValue(new Error('terminal_gone'))
    } as unknown as IPtyProvider

    const result = await inspectPtyProviderProcessForRenderer(provider, 'pty-legacy')

    expect(result.unavailable).toBe(true)
    expect(result.processEvidence?.children.verdict).toBe('unverifiable')
  })

  it('preserves non-stale renderer inspection failures', async () => {
    const failure = new Error('daemon unavailable')
    const provider = {
      inspectProcess: vi.fn().mockRejectedValue(failure)
    } as unknown as IPtyProvider

    await expect(inspectPtyProviderProcessForRenderer(provider, 'pty-1')).rejects.toBe(failure)
  })

  it('preserves an unavailable inspection result', async () => {
    const inspection = {
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true as const
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

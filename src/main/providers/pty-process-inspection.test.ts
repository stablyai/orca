import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './types'
import { inspectPtyProviderProcess } from './pty-process-inspection'

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

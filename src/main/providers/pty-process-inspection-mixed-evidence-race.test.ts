import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './types'
import { inspectPtyProviderProcess } from './pty-process-inspection'

describe('PTY inspection when the process exits between probes', () => {
  it('does not turn an exit during the foreground read into a safe idle result', async () => {
    let exited = false
    const onExit = vi.fn(() => {
      exited = true
    })
    const provider = {
      hasPty: vi.fn(() => !exited),
      getForegroundProcess: vi.fn(async () => {
        // This is the interleaving: node-pty reports the process exit while the
        // foreground probe is in flight, before the child probe starts.
        onExit()
        return null
      }),
      hasChildProcesses: vi.fn(async () => !exited)
    } as unknown as IPtyProvider

    const inspection = await inspectPtyProviderProcess(provider, 'pty-race')

    expect(onExit).toHaveBeenCalledOnce()
    expect(provider.getForegroundProcess).toHaveBeenCalledOnce()
    expect(provider.hasChildProcesses).toHaveBeenCalledOnce()
    // A process that vanished mid-read leaves the foreground half unknown while
    // the later child read sees it gone. The combined result must retain both.
    expect(inspection).toMatchObject({
      processEvidence: {
        foreground: { verdict: 'unverifiable' },
        children: { verdict: 'exited' }
      }
    })
  })
})

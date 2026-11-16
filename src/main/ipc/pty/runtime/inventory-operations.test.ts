import { describe, expect, it, vi } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { listLocalProcessesForExitProofFromRuntimeController } from './inventory-operations'

function daemonListing(ids: string[]): Pick<IPtyProvider, 'listProcesses'> {
  return { listProcesses: async () => ids.map((id) => ({ id, cwd: '', title: '' })) }
}

describe('local exit-proof inventory', () => {
  it('answers from the provider installed once startup finishes, not the in-process stand-in', async () => {
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => (finishStartup = resolve))
    let serving: Pick<IPtyProvider, 'listProcesses'> = new LocalPtyProvider()

    const listing = listLocalProcessesForExitProofFromRuntimeController(
      { getLocalPtyProviderStartupPromise: () => startup },
      () => serving
    )
    serving = daemonListing(['pty-daemon'])
    finishStartup()

    await expect(listing).resolves.toEqual({
      processes: [{ id: 'pty-daemon', cwd: '', title: '' }],
      inProcessOwner: false
    })
  })

  it('marks the in-process provider so its silence is not taken for exit', async () => {
    const inProcess = new LocalPtyProvider()
    await expect(
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => undefined },
        () => inProcess
      )
    ).resolves.toMatchObject({ inProcessOwner: true })
  })

  it('spends one startup budget across callers, then refuses at once until startup finishes', async () => {
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => (finishStartup = resolve))
    const deps = { getLocalPtyProviderStartupPromise: () => startup }
    const daemon = daemonListing(['pty-daemon'])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const first = listLocalProcessesForExitProofFromRuntimeController(deps, () => daemon, 1000)
      const firstSettled = expect(first).rejects.toThrow('still starting')
      await vi.advanceTimersByTimeAsync(1000)
      await firstSettled
      // A later caller (the next backlog row) must not start a second wait.
      await expect(
        listLocalProcessesForExitProofFromRuntimeController(deps, () => daemon, 1000)
      ).rejects.toThrow('still starting')
    } finally {
      vi.useRealTimers()
    }
    finishStartup()
    await expect(
      listLocalProcessesForExitProofFromRuntimeController(deps, () => daemon, 1000)
    ).resolves.toMatchObject({ inProcessOwner: false })
  })
})

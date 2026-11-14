import { describe, expect, it } from 'vitest'
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
})

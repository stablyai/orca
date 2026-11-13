import { afterEach, describe, expect, it } from 'vitest'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { listLocalProcessesForExitProofFromRuntimeController } from './inventory-operations'

const initialProvider = getLocalPtyProvider()

function daemonListing(ids: string[]): IPtyProvider {
  return {
    listProcesses: async () => ids.map((id) => ({ id, cwd: '', title: '' }))
  } as unknown as IPtyProvider
}

describe('local exit-proof inventory', () => {
  afterEach(() => setLocalPtyProvider(initialProvider))

  it('answers from the provider installed once startup finishes, not the in-process stand-in', async () => {
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => (finishStartup = resolve))
    const deps = {
      getLocalPtyProviderStartupPromise: () => startup
    } as unknown as PtyRuntimeControllerDeps

    const listing = listLocalProcessesForExitProofFromRuntimeController(deps)
    setLocalPtyProvider(daemonListing(['pty-daemon']))
    finishStartup()

    await expect(listing).resolves.toEqual({
      processes: [{ id: 'pty-daemon', cwd: '', title: '' }],
      inProcessOwner: false
    })
  })

  it('marks the in-process provider so its silence is not taken for exit', async () => {
    const deps = {
      getLocalPtyProviderStartupPromise: () => undefined
    } as unknown as PtyRuntimeControllerDeps
    await expect(listLocalProcessesForExitProofFromRuntimeController(deps)).resolves.toMatchObject({
      inProcessOwner: true
    })
  })
})

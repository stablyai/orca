import { describe, expect, it, vi } from 'vitest'
import type { WslHostDeploymentRecord } from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import type { WslHostServerStop } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import type { WslHostConnector, WslHostServiceDependencies } from './wsl-host-connector-contract'
import type { WslOrcadConnectIntent } from '../orcad/wsl-orcad-connection-status'
import { connectWslHostForUser } from './wsl-host-user-connect'

const record = {
  environmentId: 'wsl:ubuntu',
  distro: 'Ubuntu'
} as const satisfies Partial<WslHostDeploymentRecord>

function restart(stop: WslHostServerStop) {
  const steps: string[] = []
  const removing = new Set<string>()
  const connector = {
    stopServer: vi.fn(async () => {
      steps.push(`stop:${removing.has(record.environmentId) ? 'held' : 'open'}`)
      return stop
    }),
    connect: vi.fn(async (_distro: string, options?: WslOrcadConnectIntent) => {
      steps.push(options?.intent ? `connect:${options.intent}` : 'connect')
    })
  }
  const run = connectWslHostForUser(
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the gate's server-files check and userDataPath are read.
      deps: { hasServerFiles: () => true, userDataPath: () => '/u' } as WslHostServiceDependencies,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart calls only stopServer and connect.
      connector: connector as unknown as WslHostConnector,
      removing,
      parked: new Set()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a host with no pending Remove; nothing else is read.
    record as unknown as WslHostDeploymentRecord,
    { intent: 'restart-as-wsl-host', withdrawPendingRemoval: true }
  )
  return { run, steps, removing }
}

describe('connectWslHostForUser: Restart as WSL host', () => {
  it('stops the server with reconnects held off, then connects without an update intent', async () => {
    const { run, steps, removing } = restart({ stopped: true })
    await run
    expect(steps).toEqual(['stop:held', 'connect'])
    expect(removing.size).toBe(0)
  })

  it('reconnects and reports why when the stop is refused', async () => {
    const { run, steps } = restart({ stopped: false, reason: 'terminals would not close' })
    await expect(run).rejects.toThrow('terminals would not close')
    expect(steps).toEqual(['stop:held', 'connect'])
  })

  it('refuses a server another Orca shares, and reconnects to it', async () => {
    const { run, steps } = restart({ stopped: true, keptForOtherDesktops: ['Laptop'] })
    await expect(run).rejects.toThrow(/Another Orca uses this server \(Laptop\)/)
    expect(steps).toEqual(['stop:held', 'connect'])
  })
})

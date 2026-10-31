/**
 * The move orchestrator's automatic path end to end over a real WSL host service: its own host
 * readiness (prepareWslMoveHost), then the driver's automatic connect (E9). A host that is
 * already serving is never reconnected, and a bridge user's host is added exactly once.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslMoveResult } from '../../shared/wsl-move/wsl-move-driver-types'
import { prepareWslMoveHost } from '../persistence/moving-wsl-projects/wsl-move-host-readiness'
import { WslMoveOrchestrator } from '../persistence/moving-wsl-projects/wsl-move-orchestrator'
import { WslHostService } from '../wsl/wsl-host-service'
import { UBUNTU, makeConnector } from '../wsl/wsl-host-service-test-connector'
import { connectWslMoveHostService, wslHostRemovalPending } from './wsl-move-host-connect'

const moved: WslMoveResult = {
  outcome: 'moved',
  migrationId: 'm1',
  phase: 'retained',
  reloadRequired: true
}

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-move-orchestrator-connect-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** The orchestrator over a real host service, readying hosts as the wiring does. */
function orchestratorOverHost(connector: ReturnType<typeof makeConnector>) {
  const service = new WslHostService({
    userDataPath: () => userDataPath,
    isEnabled: () => true,
    hasServerFiles: () => true,
    publish: () => {},
    pairingChanged: () => {},
    ready: () => {},
    removed: () => {}
  })
  service.attach(connector)
  const isHostReady = (distro: string): boolean =>
    service
      .getStatuses()
      .some(
        (status) => status.distro.toLowerCase() === distro.toLowerCase() && status.state === 'ready'
      )
  const environmentId = 'wsl:ubuntu'
  // The driver's own reach for the host, in the orchestrator's (automatic) mode.
  const driverConnect = vi.fn((distro: string) =>
    connectWslMoveHostService(service, userDataPath, distro, 'automatic')
  )
  const orchestrator = new WslMoveOrchestrator({
    now: () => 1_000,
    appVersion: '1.0.0',
    autoMoveEnabled: () => true,
    prepareHost: (distro, stillWanted) =>
      prepareWslMoveHost(
        {
          readRunningDistros: async () => ({ status: 'confirmed', distros: ['Ubuntu'] }),
          isHostReady,
          removalPending: () => wslHostRemovalPending(userDataPath, distro),
          hasHost: () => service.recordForEnvironment(environmentId) !== null,
          connect: () => service.connect(environmentId),
          add: () => service.add({ distro, startIfStopped: false })
        },
        distro,
        stillWanted
      ),
    hostRemovalPending: (distro) => wslHostRemovalPending(userDataPath, distro),
    hasHost: () => service.recordForEnvironment(environmentId) !== null,
    isDistroInUse: () => true,
    isHostReady,
    preview: async (distro) => {
      await driverConnect(distro)
      return {
        outcome: 'ready',
        distro,
        repoIds: ['r1'],
        folderWorkspaceIds: [],
        changed: [],
        heldByHost: [],
        refused: [],
        blockers: []
      }
    },
    start: async (distro) => {
      await driverConnect(distro)
      return moved
    },
    finishedMove: () => null,
    checkMovedDistro: async () => 'present',
    releaseFinishedMove: async () => ({ released: false, reason: 'not-moved' }),
    load: () => new Map(),
    save: () => {},
    schedule: () => () => {},
    track: () => {},
    publish: () => {},
    runAsUserAct: (_distro, act) => act()
  })
  return { orchestrator, service, driverConnect }
}

describe('the orchestrator readying a host, then the driver reaching it (E9)', () => {
  it('never reconnects a host that is already serving', async () => {
    const connector = makeConnector([UBUNTU])
    const { orchestrator, service, driverConnect } = orchestratorOverHost(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    await orchestrator.trigger('Ubuntu', 'project-opened')
    expect(orchestrator.list()[0]?.state).toEqual({ kind: 'done', migrationId: 'm1' })
    // Preview and start each reached the host through the automatic path.
    expect(driverConnect).toHaveBeenCalledTimes(2)
    expect(connector.connect).not.toHaveBeenCalled()
    expect(connector.disconnect).not.toHaveBeenCalled()
  })

  it("adds a bridge user's host once, and the driver's automatic reach adds no connect", async () => {
    const connector = makeConnector([UBUNTU])
    const { orchestrator, service } = orchestratorOverHost(connector)
    expect(service.recordForEnvironment('wsl:ubuntu')).toBeNull()
    await orchestrator.trigger('Ubuntu', 'project-opened')
    expect(service.recordForEnvironment('wsl:ubuntu')).not.toBeNull()
    expect(connector.connect).toHaveBeenCalledTimes(1)
    expect(orchestrator.list()[0]?.state).toEqual({ kind: 'done', migrationId: 'm1' })
  })
})

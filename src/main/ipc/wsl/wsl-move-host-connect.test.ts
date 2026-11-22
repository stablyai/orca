import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslHostStore from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import { WslHostService } from '../../wsl/host-lifecycle/wsl-host-service'
import {
  UBUNTU,
  makeConnector
} from '../../wsl/host-lifecycle/__tests__/wsl-host-service-test-connector'
import type { WslHostStatus } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { connectWslMoveHostService, wslMoveHostServerState } from './wsl-move-host-connect'

const removal = vi.hoisted(() => ({ pending: false }))
vi.mock(
  '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WslHostStore>()
    return {
      ...actual,
      // E11 (#33843): `pendingStop` is optional until that PR lands, so the record gains it here.
      findWslHostDeployment: async (...args: Parameters<typeof actual.findWslHostDeployment>) => {
        const record = await actual.findWslHostDeployment(...args)
        return record && removal.pending ? { ...record, pendingStop: { reason: 'x' } } : record
      }
    }
  }
)

describe('the move driver reaching its WSL host', () => {
  let userDataPath: string

  function hostService(connector: ReturnType<typeof makeConnector>): WslHostService {
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
    return service
  }

  async function stoppedAndParkedHost() {
    const connector = makeConnector([UBUNTU])
    const service = hostService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    await service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    // A poll finding the distro stopped parks the host.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu is stopped')
    connector.connect.mockClear()
    return { connector, service }
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-move-host-connect-'))
    removal.pending = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it("a user's move connects a parked host with no visible work (E9)", async () => {
    const { connector, service } = await stoppedAndParkedHost()
    expect(await service.hasUserVisibleWork('Ubuntu')).toBe(false)
    await expect(connectWslMoveHostService(service, userDataPath, 'Ubuntu', 'user')).resolves.toBe(
      true
    )
    expect(connector.connect).toHaveBeenCalledTimes(1)
  })

  it('an automatic move, and its startup recovery, never boots a stopped distro (A1)', async () => {
    const { connector, service } = await stoppedAndParkedHost()
    await expect(
      connectWslMoveHostService(service, userDataPath, 'Ubuntu', 'automatic')
    ).rejects.toThrow('Ubuntu is stopped')
    // Running again is not enough while parked, even with visible work.
    connector.distro.state = 'running'
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(
      connectWslMoveHostService(service, userDataPath, 'Ubuntu', 'automatic')
    ).rejects.toThrow('Ubuntu is stopped')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('never connects a host whose Remove is pending, even for the user', async () => {
    const { connector, service } = await stoppedAndParkedHost()
    removal.pending = true
    for (const mode of ['user', 'automatic'] as const) {
      await expect(connectWslMoveHostService(service, userDataPath, 'Ubuntu', mode)).resolves.toBe(
        false
      )
    }
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('leaves an already-connected host alone in either mode: no reconnect', async () => {
    const connector = makeConnector([UBUNTU])
    const service = hostService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    for (const mode of ['user', 'automatic'] as const) {
      await expect(connectWslMoveHostService(service, userDataPath, 'Ubuntu', mode)).resolves.toBe(
        true
      )
    }
    expect(connector.connect).not.toHaveBeenCalled()
    expect(connector.disconnect).not.toHaveBeenCalled()
  })
})

describe('what a host lacking the WSL capability tells the move', () => {
  const ready: WslHostStatus = {
    environmentId: 'wsl:ubuntu',
    distro: 'Ubuntu',
    state: 'ready',
    detail: null
  }
  const stateFor = (status: Partial<WslHostStatus>) =>
    wslMoveHostServerState({ getStatuses: () => [{ ...ready, ...status }] }, 'wsl:ubuntu')
  const deferral = (code: string) => ({ candidateVersion: '1', code, reason: '', forceable: false })

  it('names the restart only for the not-started-as-WSL-host deferral', () => {
    expect(stateFor({ deferredUpdate: deferral('orcad_not_started_as_wsl_host') })).toEqual({
      serverState: 'restart-offered'
    })
    expect(stateFor({ deferredUpdate: deferral('orcad_update_terminals_running') })).toEqual({
      serverState: 'update-pending'
    })
    expect(stateFor({ deferredUpdate: null })).toEqual({ serverState: 'current' })
    expect(stateFor({ state: 'connecting' })).toEqual({})
  })
})

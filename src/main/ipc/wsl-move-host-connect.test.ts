import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslHostStore from '../../shared/runtime-environment-wsl-host-store'
import { WslHostService } from '../wsl/wsl-host-service'
import { UBUNTU, makeConnector } from '../wsl/wsl-host-service-test-connector'
import { connectWslMoveHostService } from './wsl-move-host-connect'

const removal = vi.hoisted(() => ({ pending: false }))
vi.mock('../../shared/runtime-environment-wsl-host-store', async (importOriginal) => {
  const actual = await importOriginal<typeof WslHostStore>()
  return {
    ...actual,
    // E11 (#33843): `pendingStop` is optional until that PR lands, so the record gains it here.
    findWslHostDeployment: (...args: Parameters<typeof actual.findWslHostDeployment>) => {
      const record = actual.findWslHostDeployment(...args)
      return record && removal.pending ? { ...record, pendingStop: { reason: 'x' } } : record
    }
  }
})

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
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    // A poll finding the distro stopped parks the host.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
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
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    await expect(connectWslMoveHostService(service, userDataPath, 'Ubuntu', 'user')).resolves.toBe(
      true
    )
    expect(connector.connect).toHaveBeenCalledTimes(1)
  })

  it('an automatic move, and its startup recovery, never boots a stopped distro (A1)', async () => {
    const { connector, service } = await stoppedAndParkedHost()
    await expect(
      connectWslMoveHostService(service, userDataPath, 'Ubuntu', 'automatic')
    ).rejects.toThrow('Ubuntu was stopped')
    // Running again is not enough while parked, even with visible work.
    connector.distro.state = 'running'
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(
      connectWslMoveHostService(service, userDataPath, 'Ubuntu', 'automatic')
    ).rejects.toThrow('Ubuntu was stopped')
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

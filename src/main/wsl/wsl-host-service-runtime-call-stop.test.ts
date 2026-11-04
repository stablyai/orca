// verify-7: an external `wsl --terminate` met first by a keystroke left the pane dead with no Start
// card: the runtime call parked the host but never said it stopped, and nothing unparked it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
import { UBUNTU, makeConnector } from './wsl-host-service-test-connector'

describe('a runtime call that finds the WSL host stopped', () => {
  let userDataPath: string
  let published: WslHostStatus[]
  let deferred: Map<string, () => unknown>

  function makeService(connector: WslHostConnector): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => true,
      hasServerFiles: () => true,
      publish: (status) => published.push(status),
      pairingChanged: vi.fn(),
      ready: vi.fn(),
      removed: vi.fn(),
      deferUntilRunning: (distro, key, task) => deferred.set(`${distro}:${key}`, task)
    })
    service.attach(connector)
    return service
  }

  async function stoppedUnderVisibleWork() {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    published = []
    return { connector, service }
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-call-stop-'))
    published = []
    deferred = new Map()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('says the host stopped, so its panes offer Start instead of a dead prompt', async () => {
    const { service } = await stoppedUnderVisibleWork()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(published).toEqual([
      expect.objectContaining({ environmentId: 'wsl:ubuntu', state: 'distro-stopped' })
    ])
    // Said once, however many calls meet the stop.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(published).toHaveLength(1)
  })

  it('reconnects its open work once the distro runs again, without booting it', async () => {
    const { connector, service } = await stoppedUnderVisibleWork()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()

    // Started some other way; the gate runs this only on a confirmed running list.
    connector.distro.state = 'running'
    deferred.get('Ubuntu:wsl-host-parked:wsl:ubuntu')?.()
    await vi.waitFor(() =>
      expect(connector.connect).toHaveBeenCalledWith('Ubuntu', { noBoot: true })
    )
  })

  it('stays down while nothing shows the host, until it is opened', async () => {
    const { connector, service } = await stoppedUnderVisibleWork()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    service.setVisibleWork([])
    connector.distro.state = 'running'
    deferred.get('Ubuntu:wsl-host-parked:wsl:ubuntu')?.()
    await Promise.resolve()
    expect(connector.connect).not.toHaveBeenCalled()
  })

  // e9-reviewer: the stop can land after liveness already reconnected and said ready.
  it('says ready again when the host was already back by the time the distro ran', async () => {
    const { connector, service } = await stoppedUnderVisibleWork()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    connector.distro.state = 'running'
    // Liveness reconnected on its own.
    await connector.connect('Ubuntu')
    connector.connect.mockClear()
    deferred.get('Ubuntu:wsl-host-parked:wsl:ubuntu')?.()
    await vi.waitFor(() =>
      expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'ready' })
    )
    expect(connector.connect).not.toHaveBeenCalled()
  })

  // What wsl-move-host-connect and wsl-host-automation-enable read: unchanged by this fix.
  it('keeps the refusal a plain, final Error with the same words', async () => {
    const { service } = await stoppedUnderVisibleWork()
    const refusal = await service.ensureForRuntimeCall('wsl:ubuntu').catch((error) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal).not.toBeInstanceOf(RemoteRuntimeClientError)
    expect(refusal).toMatchObject({
      message:
        'Ubuntu was stopped. Switch to one of its projects, or reconnect it in Settings → Remote Orca Servers, to start it again.'
    })
  })
})

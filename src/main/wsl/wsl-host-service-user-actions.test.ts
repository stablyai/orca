import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeThroughOwningService } from '../ipc/runtime-environments/runtime-environment-host-service-ops'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
import { setWslHostService } from './wsl-host-service-instance'
import { UBUNTU, makeConnector } from './wsl-host-service-test-connector'
import { onWslHostUserAction, type WslHostUserAction } from './wsl-host-user-actions'

describe('WslHostService Remove as a user action', () => {
  let userDataPath: string
  const removed = vi.fn()

  function makeService(connector: WslHostConnector): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => true,
      hasServerFiles: () => true,
      publish: () => {},
      pairingChanged: () => {},
      ready: () => {},
      removed
    })
    service.attach(connector)
    return service
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-user-actions-'))
    removed.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  // D3a: Settings → Remote Orca Servers removes through the owning service, not wslHosts:remove;
  // that Remove must decline the distro's move too, and the orchestrator's own add never counts.
  it('reports a Remove made from Settings as the user declining the host', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    const heard: WslHostUserAction[] = []
    const stop = onWslHostUserAction((action) => heard.push(action))
    setWslHostService(service)
    try {
      await service.add({ distro: 'Ubuntu' })
      const [environment] = listEnvironments(userDataPath)
      expect(environment).toBeDefined()
      await removeThroughOwningService(environment!)
      expect(heard).toEqual([{ kind: 'removed', distro: 'Ubuntu' }])
    } finally {
      stop()
      setWslHostService(null)
    }
  })

  it('reports the Remove even when the cleanup after it fails', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    removed.mockRejectedValueOnce(new Error('transport cleanup failed'))
    const heard: WslHostUserAction[] = []
    const stop = onWslHostUserAction((action) => heard.push(action))
    try {
      await expect(service.remove('wsl:ubuntu')).rejects.toThrow('transport cleanup failed')
      expect(heard).toEqual([{ kind: 'removed', distro: 'Ubuntu' }])
    } finally {
      stop()
    }
  })
})

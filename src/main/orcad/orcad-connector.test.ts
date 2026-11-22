import { describe, expect, it, vi } from 'vitest'
import type { ConnectorHostOptions } from '../connector-cloud/connector-host-install'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { installOrcadConnector } from './orcad-connector'
import { BackendServiceLifetime } from '../backend/service-composition'

const host = vi.hoisted((): { isFenced: () => boolean } => ({ isFenced: () => false }))
vi.mock('../connector-cloud/connector-host-install', () => ({
  installConnectorHost: (options: ConnectorHostOptions) => {
    host.isFenced = options.isFenced
    return { stop: () => {} }
  }
}))

describe('installOrcadConnector', () => {
  it('fences the connector before RPC and automations stop', async () => {
    const order: string[] = []
    const connector = {
      connect: () => {},
      fence: () => order.push('fence')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: orcad's connector install reads only getConnectorCloud; the installer is mocked above.
    const runtime = { getConnectorCloud: () => connector } as unknown as OrcaRuntimeService
    const lifetime = new BackendServiceLifetime()
    const register = (cleanup: Parameters<BackendServiceLifetime['add']>[0]) =>
      lifetime.add(cleanup)

    // As orcad-entry does: install, then RPC and automations register, then connect.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked installer never reads the store.
    const installed = installOrcadConnector(runtime, {} as Store, register)
    register(() => {
      order.push(`rpc.stop fenced=${host.isFenced()}`)
    })
    register(() => {
      order.push(`automations.stop fenced=${host.isFenced()}`)
    })
    installed.connect()
    await lifetime.stop()

    expect(order).toEqual(['fence', 'automations.stop fenced=true', 'rpc.stop fenced=true'])
  })
})

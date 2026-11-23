import { describe, expect, it } from 'vitest'
import type { RelayHost, RelayHostOptions } from '../runtime/mobile-cloud-relay/relay-host-install'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { createOrcadRelay } from './orcad-relay'
import { BackendServiceLifetime } from '../backend/service-composition'

describe('createOrcadRelay', () => {
  it('serves sign-ins only once started, and fences before RPC and automations stop', async () => {
    const order: string[] = []
    let options: RelayHostOptions | null = null
    const install = (next: RelayHostOptions): RelayHost => {
      options = next
      return {
        accountChanged: () => order.push('accountChanged'),
        signOutStarted: () => order.push('signOutStarted'),
        fence: () => order.push('fence'),
        ensureLive: () => {},
        stop: () => order.push('stop')
      }
    }
    const lifetime = new BackendServiceLifetime()
    const register = (cleanup: Parameters<BackendServiceLifetime['add']>[0]) =>
      lifetime.add(cleanup)

    // As orcad-entry does: create before the account, then RPC and automations register, then start.
    const relay = createOrcadRelay(register, install)
    relay.accountChanged()
    register(() => {
      order.push(`rpc.stop fenced=${options?.isFenced()}`)
    })
    register(() => {
      order.push(`automations.stop fenced=${options?.isFenced()}`)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubbed install never reads RPC.
    relay.start({} as OrcaRuntimeRpcServer)
    expect(options!.isFenced()).toBe(false)
    relay.accountChanged()
    relay.signOutStarted()
    await lifetime.stop()

    expect(order).toEqual([
      'accountChanged',
      'signOutStarted',
      'fence',
      'stop',
      'automations.stop fenced=true',
      'rpc.stop fenced=true'
    ])
  })
})

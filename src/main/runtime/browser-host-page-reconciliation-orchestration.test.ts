import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../shared/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'

const authorityRuntimeId = 'runtime-new'
const authorityEpoch = 'epoch-new'

describe('browser host page reconciliation orchestration', () => {
  it('commits a reclaimed placement only after exact completed client proof', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const server = leases.placeServerPage('server-page')
    const unrelated = leases.placeClientPage('unrelated-page', 'host-a')
    const reconciling = leases.reconcileClientPages(identity, [reclaimIntent('page-a', 8)])

    await vi.waitFor(() => expect(events).toHaveLength(1))
    const event = events[0]!
    expect(event.command.type).toBe('reclaimPage')
    expect(leases.getPlacement('page-a')).toBeUndefined()

    expect(settle(leases, identity, event, { status: 'completed' })).toBe(true)
    await expect(reconciling).resolves.toEqual({
      retained: 0,
      reclaimed: 1,
      closed: 0,
      restored: 0
    })
    expect(leases.getPlacement('page-a')).toEqual({
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pageHostGeneration: 8
    })
    expect(leases.getPlacement('server-page')).toBe(server)
    expect(leases.getPlacement('unrelated-page')).toBe(unrelated)
    expect(settle(leases, identity, event, { status: 'completed' })).toBe(false)
  })

  it('closes before restore and never pre-places the replacement', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const intent = { ...reclaimIntent('page-a', 9), browserProfileId: 'replacement' }
    const reconciling = leases.reconcileClientPages(identity, [intent])

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.command.type).toBe('closePage')
    expect(leases.getPlacement('page-a')).toBeUndefined()
    settle(leases, identity, events[0]!, { status: 'completed' })

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]!.command.type).toBe('restorePage')
    expect(leases.getPlacement('page-a')).toBeUndefined()
    settle(leases, identity, events[1]!, { status: 'completed' })

    await expect(reconciling).resolves.toEqual({
      retained: 0,
      reclaimed: 0,
      closed: 1,
      restored: 1
    })
    expect(leases.getPlacement('page-a')).toMatchObject({
      kind: 'client',
      pageHostGeneration: 9
    })
  })

  it('consumes failed inventory and requires a fresh attach before retrying', async () => {
    const firstInventory = [oldPage('page-a')]
    const { leases, identity, events, host, releaseDelivery } = setup(firstInventory)
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const intent = reclaimIntent('page-a', 8)
    const reconciling = leases.reconcileClientPages(identity, [intent])

    await vi.waitFor(() => expect(events).toHaveLength(1))
    settle(leases, identity, events[0]!, {
      status: 'failed',
      errorCode: 'browser_client_page_reconciliation_authority_stale'
    })

    await expect(reconciling).rejects.toThrow(
      'Browser host page reconciliation reclaim/close phase failed'
    )
    expect(leases.getPlacement('page-a')).toBeUndefined()
    await expect(leases.reconcileClientPages(identity, [intent])).rejects.toThrow(
      'browser_host_page_reconciliation_inventory_consumed'
    )

    releaseDelivery()
    host.disconnect()
    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: firstInventory,
      pageReconciliationProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1
    })
    const replacementIdentity = leaseIdentity(replacement.lease)
    leases.attachCommandDelivery(replacementIdentity, (event) => events.push(event))
    const retry = leases.reconcileClientPages(replacementIdentity, [reclaimIntent('page-a', 9)])
    await vi.waitFor(() => expect(events).toHaveLength(2))
    settle(leases, replacementIdentity, events[1]!, { status: 'completed' }, 'connection-b')
    await expect(retry).resolves.toMatchObject({ reclaimed: 1 })
  })

  it('aborts without accepting a late result or enabling a same-inventory retry', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const controller = new AbortController()
    const intent = reclaimIntent('page-a', 8)
    const reconciling = leases.reconcileClientPages(identity, [intent], {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    controller.abort(new Error('test abort'))
    await expect(reconciling).rejects.toThrow(
      'Browser host page reconciliation reclaim/close phase failed'
    )
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(settle(leases, identity, events[0]!, { status: 'completed' })).toBe(true)
    expect(leases.getPlacement('page-a')).toBeUndefined()
    await expect(leases.reconcileClientPages(identity, [intent])).rejects.toThrow(
      'browser_host_page_reconciliation_inventory_consumed'
    )
  })

  it('retries a proven failed close only from fresh inventory and replays its completion', async () => {
    const pageInventory = [oldPage('orphan-page')]
    const { leases, identity, events, host, releaseDelivery } = setup(pageInventory)
    const first = leases.reconcileClientPages(identity, [])
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.command.type).toBe('closePage')
    expect(events[0]!.commandSequence).toBe(1)
    settle(leases, identity, events[0]!, {
      status: 'failed',
      errorCode: 'browser_client_page_cleanup_failed'
    })
    await expect(first).rejects.toThrow(
      'Browser host page reconciliation reclaim/close phase failed'
    )

    releaseDelivery()
    host.disconnect()
    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory,
      pageReconciliationProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1
    })
    const replacementIdentity = leaseIdentity(replacement.lease)
    leases.attachCommandDelivery(replacementIdentity, (event) => events.push(event))
    const retry = leases.reconcileClientPages(replacementIdentity, [])
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]!.commandSequence).toBe(2)
    settle(leases, replacementIdentity, events[1]!, { status: 'completed' }, 'connection-b')
    await expect(retry).resolves.toMatchObject({ closed: 1 })
    expect(
      settle(leases, replacementIdentity, events[1]!, { status: 'completed' }, 'connection-b')
    ).toBe(false)
  })

  it('never retires a server placement that collides with stale client inventory', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    const server = leases.placeServerPage('page-a')

    await expect(leases.reconcileClientPages(identity, [])).rejects.toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(leases.getPlacement('page-a')).toBe(server)
    expect(events).toEqual([])
  })

  it('preserves a server placement installed while an orphan close is in flight', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    const reconciling = leases.reconcileClientPages(identity, [])
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const server = leases.placeServerPage('page-a')

    settle(leases, identity, events[0]!, { status: 'completed' })
    await expect(reconciling).resolves.toMatchObject({ closed: 1 })
    expect(leases.getPlacement('page-a')).toBe(server)
  })

  it('replays an unknown command and quarantines inventory captured before its result', async () => {
    const pageInventory = [oldPage('page-a')]
    const { leases, identity, events, host, releaseDelivery } = setup(pageInventory)
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const controller = new AbortController()
    const first = leases.reconcileClientPages(identity, [reclaimIntent('page-a', 8)], {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const unknown = events[0]!
    controller.abort(new Error('lost result'))
    await expect(first).rejects.toThrow(
      'Browser host page reconciliation reclaim/close phase failed'
    )

    releaseDelivery()
    host.disconnect()
    const secondHost = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory,
      pageReconciliationProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1
    })
    const secondIdentity = leaseIdentity(secondHost.lease)
    const releaseSecondDelivery = leases.attachCommandDelivery(secondIdentity, (event) =>
      events.push(event)
    )
    expect(events[1]).toEqual(unknown)
    settle(leases, secondIdentity, events[1]!, { status: 'completed' }, 'connection-b')
    await expect(
      leases.reconcileClientPages(secondIdentity, [reclaimIntent('page-a', 9)])
    ).rejects.toThrow('browser_host_page_reconciliation_inventory_consumed')
    expect(leases.getPlacement('page-a')).toBeUndefined()

    releaseSecondDelivery()
    secondHost.disconnect()
    const thirdHost = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-c',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      pageReconciliationProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1
    })
    const thirdIdentity = leaseIdentity(thirdHost.lease)
    leases.attachCommandDelivery(thirdIdentity, (event) => events.push(event))
    const recovered = leases.reconcileClientPages(thirdIdentity, [reclaimIntent('page-a', 9)])
    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events[2]!.command.type).toBe('restorePage')
    settle(leases, thirdIdentity, events[2]!, { status: 'completed' }, 'connection-c')
    await expect(recovered).resolves.toMatchObject({ restored: 1 })
    expect(leases.getPlacement('page-a')).toMatchObject({ pageHostGeneration: 9 })
  })

  it('abandons an in-flight attempt when its connection enters reconnect grace', async () => {
    const pageInventory = [oldPage('page-a'), oldPage('page-b')]
    const { leases, identity, events, host, releaseDelivery } = setup(pageInventory)
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const controller = new AbortController()
    let outcome: 'pending' | 'rejected' = 'pending'
    const reconciling = leases
      .reconcileClientPages(identity, [reclaimIntent('page-a', 8), reclaimIntent('page-b', 9)], {
        maxConcurrency: 1,
        signal: controller.signal
      })
      .catch(() => {
        outcome = 'rejected'
      })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    host.disconnect()
    await flushMicrotasks()
    const outcomeAfterDisconnect = outcome
    controller.abort(new Error('test cleanup'))
    await reconciling

    releaseDelivery()
    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory,
      pageReconciliationProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1
    })
    const replacementIdentity = leaseIdentity(replacement.lease)
    leases.attachCommandDelivery(replacementIdentity, (event) => events.push(event))
    expect(events[1]).toEqual(events[0])
    settle(leases, replacementIdentity, events[1]!, { status: 'completed' }, 'connection-b')
    await flushMicrotasks()

    expect(outcomeAfterDisconnect).toBe('rejected')
    expect(events).toHaveLength(2)
    await expect(
      leases.reconcileClientPages(replacementIdentity, [
        reclaimIntent('page-a', 9),
        reclaimIntent('page-b', 10)
      ])
    ).rejects.toThrow('browser_host_page_reconciliation_inventory_consumed')
  })

  it('is single-flight and emits nothing for a legacy lease', async () => {
    const negotiated = setup([oldPage('page-a')])
    negotiated.leases.grantExecutionHost(negotiated.identity, 'native:runtime-new:1')
    const first = negotiated.leases.reconcileClientPages(negotiated.identity, [
      reclaimIntent('page-a', 8)
    ])
    await vi.waitFor(() => expect(negotiated.events).toHaveLength(1))
    await expect(
      negotiated.leases.reconcileClientPages(negotiated.identity, [reclaimIntent('page-a', 9)])
    ).rejects.toThrow('browser_host_page_reconciliation_pending')
    settle(negotiated.leases, negotiated.identity, negotiated.events[0]!, {
      status: 'completed'
    })
    await first

    const leases = registry()
    const host = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'legacy-connection',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1
    })
    const identity = leaseIdentity(host.lease)
    const delivery = vi.fn()
    leases.attachCommandDelivery(identity, delivery)
    await expect(leases.reconcileClientPages(identity, [])).rejects.toThrow(
      'browser_host_reconciliation_protocol_required'
    )
    expect(delivery).not.toHaveBeenCalled()
  })
})

function registry(): BrowserHostLeaseRegistry {
  return new BrowserHostLeaseRegistry({ authorityRuntimeId, authorityEpoch })
}

function setup(pageInventory: BrowserClientHostedPageInventory[]) {
  const leases = registry()
  const host = leases.attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory,
    pageReconciliationProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1
  })
  const identity = leaseIdentity(host.lease)
  const events: BrowserClientHostCommandEvent[] = []
  const releaseDelivery = leases.attachCommandDelivery(identity, (event) => events.push(event))
  return { leases, host, identity, events, releaseDelivery }
}

function leaseIdentity(lease: {
  authorityEpoch: string
  browserHostClientId: string
  browserHostGeneration: number
  pairedDeviceId: string
}) {
  return {
    authorityEpoch: lease.authorityEpoch,
    browserHostClientId: lease.browserHostClientId,
    browserHostGeneration: lease.browserHostGeneration,
    pairedDeviceId: lease.pairedDeviceId
  }
}

function oldPage(browserPageId: string): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'runtime-old',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    browserPageId,
    pageHostGeneration: 7,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-new:1',
    state: 'active',
    currentUrl: 'https://remote.internal/'
  }
}

function reclaimIntent(
  browserPageId: string,
  pageHostGeneration: number
): BrowserHostRuntimePageIntent {
  return {
    authorityRuntimeId,
    authorityEpoch,
    browserHostClientId: 'host-a',
    browserHostGeneration: 1,
    browserPageId,
    pageHostGeneration,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-new:1',
    reclaimFrom: { ...oldPage(browserPageId), pairedDeviceId: 'device-a' }
  }
}

function settle(
  leases: BrowserHostLeaseRegistry,
  identity: ReturnType<typeof leaseIdentity>,
  event: BrowserClientHostCommandEvent,
  result: { status: 'completed' } | { status: 'failed'; errorCode: string },
  connectionId = 'connection-a'
): boolean {
  return leases.settleClientPageCommand({ ...identity, connectionId }, { ...event, result })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

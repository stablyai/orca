import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../shared/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'

const authorityRuntimeId = 'runtime-new'
const authorityEpoch = 'epoch-new'

// Adoption is the only caller of the orchestrator, and it never rethrows: a run that refuses or
// fails leaves the pages it did place and reports the rest as unadopted, so every guard below is
// pinned by what the client was asked to do and what ended up placed, not by a rejection.
describe('browser host page reconciliation orchestration', () => {
  it('commits a reclaimed placement only after exact completed client proof', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const server = leases.placeServerPage('server-page')
    const unrelated = leases.placeClientPage('unrelated-page', 'host-a')
    const adopting = leases.adoptClientPages(identity, [reclaimIntent('page-a', 8)])

    await vi.waitFor(() => expect(events).toHaveLength(1))
    const event = events[0]!
    expect(event.command.type).toBe('reclaimPage')
    expect(leases.getPlacement('page-a')).toBeUndefined()

    expect(settle(leases, identity, event, { status: 'completed' })).toBe(true)
    await expect(adopting).resolves.toEqual(['page-a'])
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
    const adopting = leases.adoptClientPages(identity, [replacementIntent('page-a', 9)])

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.command.type).toBe('closePage')
    expect(leases.getPlacement('page-a')).toBeUndefined()
    settle(leases, identity, events[0]!, { status: 'completed' })

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]!.command.type).toBe('restorePage')
    expect(leases.getPlacement('page-a')).toBeUndefined()
    settle(leases, identity, events[1]!, { status: 'completed' })

    await expect(adopting).resolves.toEqual(['page-a'])
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
    const adopting = leases.adoptClientPages(identity, [intent])

    await vi.waitFor(() => expect(events).toHaveLength(1))
    settle(leases, identity, events[0]!, {
      status: 'failed',
      errorCode: 'browser_client_page_reconciliation_authority_stale'
    })

    await expect(adopting).resolves.toEqual([])
    expect(leases.getPlacement('page-a')).toBeUndefined()
    // The same inventory can no longer be planned against, so no second command is ever issued.
    await expect(leases.adoptClientPages(identity, [intent])).resolves.toEqual([])
    expect(events).toHaveLength(1)

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
    const retry = leases.adoptClientPages(replacementIdentity, [reclaimIntent('page-a', 9)])
    await vi.waitFor(() => expect(events).toHaveLength(2))
    settle(leases, replacementIdentity, events[1]!, { status: 'completed' }, 'connection-b')
    await expect(retry).resolves.toEqual(['page-a'])
  })

  it('aborts without accepting a late result or enabling a same-inventory retry', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const controller = new AbortController()
    const intent = reclaimIntent('page-a', 8)
    const adopting = leases.adoptClientPages(identity, [intent], { signal: controller.signal })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    controller.abort(new Error('test abort'))
    await expect(adopting).resolves.toEqual([])
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(settle(leases, identity, events[0]!, { status: 'completed' })).toBe(true)
    expect(leases.getPlacement('page-a')).toBeUndefined()
    await expect(leases.adoptClientPages(identity, [intent])).resolves.toEqual([])
    expect(events).toHaveLength(1)
  })

  it('retries a proven failed close only from fresh inventory and replays its completion', async () => {
    const pageInventory = [oldPage('page-a')]
    const { leases, identity, events, host, releaseDelivery } = setup(pageInventory)
    const first = leases.adoptClientPages(identity, [replacementIntent('page-a', 8)])
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.command.type).toBe('closePage')
    expect(events[0]!.commandSequence).toBe(1)
    settle(leases, identity, events[0]!, {
      status: 'failed',
      errorCode: 'browser_client_page_cleanup_failed'
    })
    await expect(first).resolves.toEqual([])

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
    const retry = leases.adoptClientPages(replacementIdentity, [replacementIntent('page-a', 9)])
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]!.commandSequence).toBe(2)
    settle(leases, replacementIdentity, events[1]!, { status: 'completed' }, 'connection-b')

    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events[2]!.command.type).toBe('restorePage')
    settle(leases, replacementIdentity, events[2]!, { status: 'completed' }, 'connection-b')
    await expect(retry).resolves.toEqual(['page-a'])
    expect(
      settle(leases, replacementIdentity, events[2]!, { status: 'completed' }, 'connection-b')
    ).toBe(false)
  })

  it('never retires a server placement that collides with claimed client inventory', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    const server = leases.placeServerPage('page-a')

    await expect(leases.adoptClientPages(identity, [reclaimIntent('page-a', 8)])).resolves.toEqual(
      []
    )
    expect(leases.getPlacement('page-a')).toBe(server)
    expect(events).toEqual([])
  })

  it('holds the replacement slot against another placement while the close is in flight', async () => {
    const { leases, identity, events } = setup([oldPage('page-a')])
    const adopting = leases.adoptClientPages(identity, [replacementIntent('page-a', 9)])
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.command.type).toBe('closePage')

    // The page has no placement between the close and the restore, but the slot is not free:
    // handing it to anything else would strand the restore this plan has already committed to.
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(() => leases.placeServerPage('page-a')).toThrow(
      'browser_page_replacement_requires_retirement'
    )

    settle(leases, identity, events[0]!, { status: 'completed' })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    settle(leases, identity, events[1]!, { status: 'completed' })
    await expect(adopting).resolves.toEqual(['page-a'])
    expect(leases.getPlacement('page-a')).toMatchObject({ kind: 'client', pageHostGeneration: 9 })
  })

  it('replays an unknown command and quarantines inventory captured before its result', async () => {
    const pageInventory = [oldPage('page-a')]
    const { leases, identity, events, host, releaseDelivery } = setup(pageInventory)
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const controller = new AbortController()
    const first = leases.adoptClientPages(identity, [reclaimIntent('page-a', 8)], {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const unknown = events[0]!
    controller.abort(new Error('lost result'))
    await expect(first).resolves.toEqual([])

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
      leases.adoptClientPages(secondIdentity, [reclaimIntent('page-a', 9)])
    ).resolves.toEqual([])
    expect(events).toHaveLength(2)
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
    const recovered = leases.adoptClientPages(thirdIdentity, [reclaimIntent('page-a', 9)])
    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events[2]!.command.type).toBe('restorePage')
    settle(leases, thirdIdentity, events[2]!, { status: 'completed' }, 'connection-c')
    await expect(recovered).resolves.toEqual(['page-a'])
    expect(leases.getPlacement('page-a')).toMatchObject({ pageHostGeneration: 9 })
  })

  it('abandons an in-flight attempt when its connection enters reconnect grace', async () => {
    const pageInventory = [oldPage('page-a'), oldPage('page-b')]
    const { leases, identity, events, host, releaseDelivery } = setup(pageInventory)
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const controller = new AbortController()
    let settled = false
    const adopting = leases
      .adoptClientPages(identity, [reclaimIntent('page-a', 8), reclaimIntent('page-b', 9)], {
        maxConcurrency: 1,
        signal: controller.signal
      })
      .then(() => {
        settled = true
      })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    host.disconnect()
    await flushMicrotasks()
    // Why: the attempt must give up with the connection rather than wait out a client that can
    // never answer, so it has to be settled before anything aborts it from the outside.
    const settledAfterDisconnect = settled
    controller.abort(new Error('test cleanup'))
    await adopting

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

    expect(settledAfterDisconnect).toBe(true)
    expect(events).toHaveLength(2)
    await expect(
      leases.adoptClientPages(replacementIdentity, [
        reclaimIntent('page-a', 9),
        reclaimIntent('page-b', 10)
      ])
    ).resolves.toEqual([])
  })

  it('aborts an in-flight reconciliation when its lease is released', async () => {
    const { leases, identity, events, host } = setup([oldPage('page-a')])
    leases.grantExecutionHost(identity, 'native:runtime-new:1')
    const adopting = leases.adoptClientPages(identity, [reclaimIntent('page-a', 8)])
    await vi.waitFor(() => expect(events).toHaveLength(1))

    host.release()

    // Why: a fenced lease must abort its attempt, not wait out a client that can never answer.
    await expect(adopting).resolves.toEqual([])
    expect(events).toHaveLength(1)
  })

  it('is single-flight and emits nothing for a legacy lease', async () => {
    const negotiated = setup([oldPage('page-a')])
    negotiated.leases.grantExecutionHost(negotiated.identity, 'native:runtime-new:1')
    const first = negotiated.leases.adoptClientPages(negotiated.identity, [
      reclaimIntent('page-a', 8)
    ])
    await vi.waitFor(() => expect(negotiated.events).toHaveLength(1))
    await expect(
      negotiated.leases.adoptClientPages(negotiated.identity, [reclaimIntent('page-a', 9)])
    ).resolves.toEqual([])
    expect(negotiated.events).toHaveLength(1)
    settle(negotiated.leases, negotiated.identity, negotiated.events[0]!, {
      status: 'completed'
    })
    await expect(first).resolves.toEqual(['page-a'])

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
    await expect(leases.adoptClientPages(identity, [reclaimIntent('page-a', 8)])).resolves.toEqual(
      []
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
    authorityRuntimeId: 'runtime-new',
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

/** A profile the live guest cannot be rekeyed into, so the plan must close it and restore. */
function replacementIntent(
  browserPageId: string,
  pageHostGeneration: number
): BrowserHostRuntimePageIntent {
  return {
    ...reclaimIntent(browserPageId, pageHostGeneration),
    browserProfileId: 'replacement'
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

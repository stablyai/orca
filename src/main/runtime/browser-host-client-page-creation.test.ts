import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'

const authorityRuntimeId = 'runtime-a'
const authorityEpoch = 'epoch-a'

describe('browser host client page creation', () => {
  it('rejects placement on a host owned by another paired device', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-b', 'device-b', 'connection-b')
    let command: BrowserClientHostCommandEvent | undefined
    leases.attachCommandDelivery(identity(selected), (event) => {
      command = event
    })

    const creation = leases.createClientPage({
      browserPageId: 'page-foreign-host',
      browserHostClientId: 'host-b',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'native:runtime-a:7'
    })
    await Promise.resolve()
    if (command) {
      settle(leases, selected, command, { status: 'completed' })
    }

    await expect(creation).rejects.toThrow('browser_host_lease_stale')
    expect(command).toBeUndefined()
    expect(leases.getPlacement('page-foreign-host')).toBeUndefined()
  })

  it('commits the exact requested host only after its create proof', async () => {
    const leases = registry()
    attachHost(leases, 'host-a', 'device-a', 'connection-a')
    const selected = attachHost(leases, 'host-b', 'device-b', 'connection-b')
    let command: BrowserClientHostCommandEvent | undefined
    leases.attachCommandDelivery(identity(selected), (event) => {
      command = event
    })

    const creation = leases.createClientPage({
      browserPageId: 'page-stable',
      browserHostClientId: 'host-b',
      pairedDeviceId: 'device-b',
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:7'
    })

    expect(command).toMatchObject({
      browserPageId: 'page-stable',
      browserHostClientId: 'host-b',
      command: {
        type: 'createPage',
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:7'
      }
    })
    expect(leases.getPlacement('page-stable')).toBeUndefined()
    settle(leases, selected, command!, { status: 'completed' })

    await expect(creation).resolves.toMatchObject({
      kind: 'client',
      browserHostClientId: 'host-b',
      browserHostGeneration: selected.browserHostGeneration,
      pageHostGeneration: command!.pageHostGeneration
    })
    expect(leases.getPlacement('page-stable')).toMatchObject({
      kind: 'client',
      browserHostClientId: 'host-b'
    })
    expect(leases.getClientPageExecutionHostKey('page-stable')).toBe('native:runtime-a:7')
  })

  it('rolls back a failed create and sends an exact best-effort close', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
    const commands: BrowserClientHostCommandEvent[] = []
    leases.attachCommandDelivery(identity(selected), (event) => commands.push(event))

    const creation = leases.createClientPage({
      browserPageId: 'page-failed',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'ssh:target-a:3'
    })
    settle(leases, selected, commands[0]!, {
      status: 'failed',
      errorCode: 'browser_client_page_mount_failed'
    })

    await expect(creation).rejects.toThrow('browser_client_page_mount_failed')
    expect(commands.map((command) => command.command.type)).toEqual(['createPage', 'closePage'])
    expect(leases.getPlacement('page-failed')).toBeUndefined()
    expect(leases.getClientPageExecutionHostKey('page-failed')).toBeUndefined()
    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
    settle(leases, selected, commands[1]!, {
      status: 'failed',
      errorCode: 'browser_client_page_reconciliation_authority_stale'
    })
    await Promise.resolve()
    expect(() => settle(leases, selected, commands[1]!, { status: 'completed' })).toThrow(
      'browser_client_page_placement_required'
    )
  })

  it('requires negotiated reconciliation before selecting client placement', async () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-old',
      pairedDeviceId: 'device-old',
      connectionId: 'connection-old',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1
    })

    await expect(
      leases.createClientPage({
        browserPageId: 'page-old-host',
        browserHostClientId: 'host-old',
        pairedDeviceId: 'device-old',
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:7'
      })
    ).rejects.toThrow('browser_host_reconciliation_protocol_required')
    expect(leases.getPlacement('page-old-host')).toBeUndefined()
  })

  it('retains one execution route grant until the last page placement retires', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
    const commands: BrowserClientHostCommandEvent[] = []
    leases.attachCommandDelivery(identity(selected), (event) => commands.push(event))

    const first = leases.createClientPage({
      browserPageId: 'page-a',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'ssh:target-a:3'
    })
    settle(leases, selected, commands[0]!, { status: 'completed' })
    const firstPlacement = await first
    const second = leases.createClientPage({
      browserPageId: 'page-b',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'ssh:target-a:3'
    })
    settle(leases, selected, commands[1]!, { status: 'completed' })
    const secondPlacement = await second
    const tunnel = leases.openTunnel(
      { ...identity(selected), executionHostKey: 'ssh:target-a:3' },
      { requireExecutionHostGrant: true }
    )
    let tunnelFence: string | undefined
    void tunnel.whenFenced.then((reason) => {
      tunnelFence = reason
    })

    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).not.toThrow()
    expect(
      leases.completePageRetirement(leases.beginPageRetirement('page-a', firstPlacement))
    ).toBe(true)
    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).not.toThrow()
    expect(tunnelFence).toBeUndefined()
    expect(
      leases.completePageRetirement(leases.beginPageRetirement('page-b', secondPlacement))
    ).toBe(true)
    await expect(tunnel.whenFenced).resolves.toBe('released')
    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
  })

  it('does not commit a completed create after its exact host lease is replaced', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
    let command: BrowserClientHostCommandEvent | undefined
    leases.attachCommandDelivery(identity(selected), (event) => {
      command = event
    })
    const creation = leases.createClientPage({
      browserPageId: 'page-replaced',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'ssh:target-a:3'
    })

    settle(leases, selected, command!, { status: 'completed' })
    const replacement = attachHost(leases, 'host-a', 'device-a', 'connection-b')

    await expect(creation).rejects.toThrow('browser_host_lease_stale')
    expect(leases.getPlacement('page-replaced')).toBeUndefined()
    expect(leases.getClientPageExecutionHostKey('page-replaced')).toBeUndefined()
    expect(() => leases.requireExecutionHost(identity(replacement), 'ssh:target-a:3')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
  })

  it('cancels an in-flight create when its exact host lease is replaced', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
    let command: BrowserClientHostCommandEvent | undefined
    leases.attachCommandDelivery(identity(selected), (event) => {
      command = event
    })
    const creation = leases.createClientPage({
      browserPageId: 'page-in-flight',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'ssh:target-a:3'
    })

    const replacement = attachHost(leases, 'host-a', 'device-a', 'connection-b')

    await expect(creation).rejects.toThrow('browser_host_command_outcome_unknown')
    expect(leases.getPlacement('page-in-flight')).toBeUndefined()
    expect(() => settle(leases, selected, command!, { status: 'completed' })).toThrow(
      'browser_host_lease_stale'
    )
    expect(() => leases.requireExecutionHost(identity(replacement), 'ssh:target-a:3')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
  })

  it('cleans its reservation and grant after command delivery fails', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
    leases.attachCommandDelivery(identity(selected), () => {
      throw new Error('transport failed')
    })

    await expect(
      leases.createClientPage({
        browserPageId: 'page-undelivered',
        browserHostClientId: 'host-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'default',
        executionHostKey: 'ssh:target-a:3'
      })
    ).rejects.toThrow('browser_host_command_delivery_failed')
    expect(leases.getPlacement('page-undelivered')).toBeUndefined()
    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
  })

  it('releases a page grant only for its exact retirement token', async () => {
    const leases = registry()
    const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
    let command: BrowserClientHostCommandEvent | undefined
    leases.attachCommandDelivery(identity(selected), (event) => {
      command = event
    })
    const creation = leases.createClientPage({
      browserPageId: 'page-exact-retirement',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'ssh:target-a:3'
    })
    settle(leases, selected, command!, { status: 'completed' })
    const placement = await creation
    const retirement = leases.beginPageRetirement('page-exact-retirement', placement)

    expect(leases.completePageRetirement({ ...retirement })).toBe(false)
    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).not.toThrow()
    expect(leases.completePageRetirement(retirement)).toBe(true)
    expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
  })

  it('bounds missing create proof and releases its reservation and grant', async () => {
    vi.useFakeTimers()
    try {
      const leases = registry()
      const selected = attachHost(leases, 'host-a', 'device-a', 'connection-a')
      const commands: BrowserClientHostCommandEvent[] = []
      leases.attachCommandDelivery(identity(selected), (event) => commands.push(event))
      const creation = leases.createClientPage({
        browserPageId: 'page-timeout',
        browserHostClientId: 'host-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'default',
        executionHostKey: 'ssh:target-a:3',
        timeoutMs: 25
      })
      const rejected = expect(creation).rejects.toThrow('browser_host_page_creation_timeout')

      await vi.advanceTimersByTimeAsync(25)

      await rejected
      expect(commands.map((command) => command.command.type)).toEqual(['createPage', 'closePage'])
      expect(leases.getPlacement('page-timeout')).toBeUndefined()
      expect(() => leases.requireExecutionHost(identity(selected), 'ssh:target-a:3')).toThrow(
        'browser_tunnel_execution_host_not_granted'
      )
      settle(leases, selected, commands[0]!, { status: 'completed' })
      settle(leases, selected, commands[1]!, { status: 'completed' })
      await Promise.resolve()
      expect(() => settle(leases, selected, commands[1]!, { status: 'completed' })).toThrow(
        'browser_client_page_placement_required'
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

function registry(): BrowserHostLeaseRegistry {
  return new BrowserHostLeaseRegistry({ authorityRuntimeId, authorityEpoch })
}

function attachHost(
  leases: BrowserHostLeaseRegistry,
  browserHostClientId: string,
  pairedDeviceId: string,
  connectionId: string
) {
  return leases.attach({
    browserHostClientId,
    pairedDeviceId,
    connectionId,
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory: [],
    pageReconciliationProtocolVersion: 1
  }).lease
}

function identity(lease: ReturnType<typeof attachHost>) {
  return {
    authorityEpoch: lease.authorityEpoch,
    browserHostClientId: lease.browserHostClientId,
    browserHostGeneration: lease.browserHostGeneration,
    pairedDeviceId: lease.pairedDeviceId
  }
}

function settle(
  leases: BrowserHostLeaseRegistry,
  lease: ReturnType<typeof attachHost>,
  command: BrowserClientHostCommandEvent,
  result: { status: 'completed' } | { status: 'failed'; errorCode: string }
): void {
  leases.settleClientPageCommand(
    { ...identity(lease), connectionId: lease.connectionId },
    {
      authorityRuntimeId: command.authorityRuntimeId,
      authorityEpoch: command.authorityEpoch,
      browserHostClientId: command.browserHostClientId,
      browserHostGeneration: command.browserHostGeneration,
      pageCommandProtocolVersion: command.pageCommandProtocolVersion,
      ...(command.pageReconciliationProtocolVersion
        ? { pageReconciliationProtocolVersion: command.pageReconciliationProtocolVersion }
        : {}),
      browserPageId: command.browserPageId,
      pageHostGeneration: command.pageHostGeneration,
      commandSequence: command.commandSequence,
      commandId: command.commandId,
      result
    }
  )
}

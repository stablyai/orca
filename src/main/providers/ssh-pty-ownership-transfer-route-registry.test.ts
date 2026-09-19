import { describe, expect, it, vi } from 'vitest'
import {
  SshPtyOwnershipTransferRouteRegistry,
  type SshPtyOwnershipTransferPublishedRoute
} from './ssh-pty-ownership-transfer-route-registry'
import type { SshPtyOwnershipTransferClient } from './ssh-pty-ownership-transfer-client'

const identity = {
  version: 1 as const,
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'inc-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 2,
  destinationRuntimeId: 'runtime-1'
}

const capabilities = {
  protocolVersions: [1],
  maxReplayBytes: 1024,
  maxInputIds: 32,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  statusQuery: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true,
  postCommitReplay: true,
  reconnectRekey: true
} as const

function createClient() {
  let exitListener: ((event: typeof identity & { attachmentId: string }) => void) | undefined
  let transportLost: (() => void) | undefined
  const client = {
    input: vi.fn(async () => ({ accepted: true, duplicate: false })),
    retireInput: vi.fn(async () => ({ retired: 1 })),
    controlDestination: vi.fn(async () => ({
      ...identity,
      attachmentId: 'attachment-1',
      controlId: 'control-1',
      outcome: 'applied',
      duplicate: false
    })),
    onDestinationExit: vi.fn((_caps: unknown, callback: typeof exitListener) => {
      exitListener = callback
      return () => {
        exitListener = undefined
      }
    }),
    onTransportLost: vi.fn((callback: () => void) => {
      transportLost = callback
      return () => {
        transportLost = undefined
      }
    })
  }
  return {
    client,
    emitExit: (event: typeof identity & { attachmentId: string }) => exitListener?.(event),
    loseTransport: () => transportLost?.()
  }
}

function route(providerGeneration = 7): SshPtyOwnershipTransferPublishedRoute {
  return {
    ptyId: 'ssh:target-1@@pty-1',
    identity,
    attachmentId: 'attachment-1',
    capabilities,
    providerGeneration
  }
}

describe('SshPtyOwnershipTransferRouteRegistry', () => {
  it('routes input and controls only after an exact published route is installed', async () => {
    const { client } = createClient()
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      client as unknown as SshPtyOwnershipTransferClient,
      7,
      { createOperationId: vi.fn(() => 'operation-1'), onTransportLost: () => () => {} }
    )

    expect(registry.write(route().ptyId, 'before')).toBe(null)
    registry.install(route())
    expect(registry.write(route().ptyId, 'hello')).toBe(true)
    await expect(registry.writeWithSettlement(route().ptyId, 'world')).resolves.toBe(true)
    await registry.control(route().ptyId, { kind: 'resize', cols: 100, rows: 30 })

    expect(client.input).toHaveBeenCalledTimes(2)
    expect(client.input).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'world', inputId: 'operation-1' })
    )
    expect(client.controlDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: 'attachment-1',
        control: { kind: 'resize', cols: 100, rows: 30 }
      }),
      capabilities,
      undefined
    )
    expect(client.retireInput).toHaveBeenCalled()
    registry.dispose()
  })

  it('fences a transferred PTY after destination exit or transport loss', () => {
    const first = createClient()
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      first.client as unknown as SshPtyOwnershipTransferClient,
      7,
      {
        onTransportLost: (callback) => {
          first.client.onTransportLost(callback)
          return () => {}
        }
      }
    )
    registry.install(route())
    first.emitExit({ ...identity, attachmentId: 'attachment-1' })
    expect(registry.write(route().ptyId, 'after-exit')).toBe(false)

    const second = createClient()
    const secondRegistry = new SshPtyOwnershipTransferRouteRegistry(
      second.client as unknown as SshPtyOwnershipTransferClient,
      7,
      {
        onTransportLost: (callback) => {
          second.client.onTransportLost(callback)
          return () => {}
        }
      }
    )
    secondRegistry.install(route())
    second.loseTransport()
    expect(secondRegistry.write(route().ptyId, 'after-loss')).toBe(false)
    secondRegistry.dispose()
    registry.dispose()
  })

  it('serializes input and controls within one PTY ordering lane', async () => {
    const { client } = createClient()
    let resolveInput: ((result: { accepted: boolean; duplicate: boolean }) => void) | undefined
    client.input.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInput = resolve
        })
    )
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      client as unknown as SshPtyOwnershipTransferClient,
      7
    )
    registry.install(route())

    const input = registry.writeWithSettlement(route().ptyId, 'first')
    await Promise.resolve()
    const control = registry.control(route().ptyId, { kind: 'clearBuffer' })
    await Promise.resolve()
    expect(client.controlDestination).not.toHaveBeenCalled()

    resolveInput?.({ accepted: true, duplicate: false })
    await expect(input).resolves.toBe(true)
    await expect(control).resolves.toBeUndefined()
    expect(client.controlDestination).toHaveBeenCalledTimes(1)
    registry.dispose()
  })

  it('retries an ambiguous input with the same durable ID and fences after failure', async () => {
    const { client } = createClient()
    client.input
      .mockRejectedValueOnce(new Error('response_lost'))
      .mockResolvedValueOnce({ accepted: false, duplicate: true })
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      client as unknown as SshPtyOwnershipTransferClient,
      7,
      { createOperationId: () => 'input-1' }
    )
    registry.install(route())

    await expect(registry.writeWithSettlement(route().ptyId, 'retry-me')).resolves.toBe(true)
    expect(client.input).toHaveBeenCalledTimes(2)
    const inputCalls = client.input.mock.calls as unknown as [{ inputId: string }][]
    expect(inputCalls[0]?.[0].inputId).toBe('input-1')
    expect(inputCalls[1]?.[0].inputId).toBe('input-1')
    expect(client.retireInput).toHaveBeenCalledWith(
      expect.objectContaining({ inputIds: ['input-1'] })
    )

    client.input.mockRejectedValue(new Error('unverifiable'))
    await expect(registry.writeWithSettlement(route().ptyId, 'fence-me')).rejects.toThrow(
      'unverifiable'
    )
    expect(registry.write(route().ptyId, 'after-fence')).toBe(false)
    registry.dispose()
  })

  it('retains a caller input ID through API retry until explicit retirement', async () => {
    const { client } = createClient()
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      client as unknown as SshPtyOwnershipTransferClient,
      7
    )
    registry.install(route())

    await expect(
      registry.writeWithSettlement(route().ptyId, 'retry-safe', {
        operationId: 'caller-input-1'
      })
    ).resolves.toBe(true)
    expect(client.retireInput).not.toHaveBeenCalled()

    client.input.mockResolvedValueOnce({ accepted: false, duplicate: true })
    await expect(
      registry.writeWithSettlement(route().ptyId, 'retry-safe', {
        operationId: 'caller-input-1'
      })
    ).resolves.toBe(true)
    const inputCalls = client.input.mock.calls as unknown as [{ inputId: string }][]
    expect(inputCalls.map(([request]) => request.inputId)).toEqual([
      'caller-input-1',
      'caller-input-1'
    ])
    expect(() =>
      registry.writeWithSettlement(route().ptyId, 'changed', {
        operationId: 'caller-input-1'
      })
    ).toThrow('pty_ownership_transfer_operation_conflict')

    await expect(registry.retireWriteOperation(route().ptyId, 'caller-input-1')).resolves.toBe(true)
    expect(client.retireInput).toHaveBeenCalledWith(
      expect.objectContaining({ inputIds: ['caller-input-1'] })
    )
    registry.dispose()
  })

  it('preserves a caller control ID across transport loss and attachment replacement', async () => {
    const harness = createClient()
    harness.client.controlDestination.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { attachmentId: string; controlId: string }
      return {
        ...identity,
        attachmentId: request.attachmentId,
        controlId: request.controlId,
        outcome: 'applied',
        duplicate: false
      }
    })
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      harness.client as unknown as SshPtyOwnershipTransferClient,
      7,
      {
        onTransportLost: (callback) => {
          harness.client.onTransportLost(callback)
          return () => {}
        }
      }
    )
    registry.install(route())
    await registry.control(
      route().ptyId,
      { kind: 'sendSignal', signal: 'SIGINT' },
      { operationId: 'caller-control-1' }
    )

    harness.loseTransport()
    registry.install({ ...route(), attachmentId: 'attachment-2' })
    await registry.control(
      route().ptyId,
      { kind: 'sendSignal', signal: 'SIGINT' },
      { operationId: 'caller-control-1' }
    )

    const controlCalls = harness.client.controlDestination.mock.calls as unknown as [
      { attachmentId: string; controlId: string }
    ][]
    expect(controlCalls.map(([request]) => [request.attachmentId, request.controlId])).toEqual([
      ['attachment-1', 'caller-control-1'],
      ['attachment-2', 'caller-control-1']
    ])
    registry.dispose()
  })

  it('bounds caller retry records to the destination deduplication window', async () => {
    const { client } = createClient()
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      client as unknown as SshPtyOwnershipTransferClient,
      7
    )
    const boundedRoute = {
      ...route(),
      capabilities: { ...capabilities, maxInputIds: 1 }
    }
    registry.install(boundedRoute)

    await registry.writeWithSettlement(boundedRoute.ptyId, 'first', { operationId: 'input-1' })
    expect(() =>
      registry.writeWithSettlement(boundedRoute.ptyId, 'second', { operationId: 'input-2' })
    ).toThrow('pty_ownership_transfer_retry_window_exhausted')
    await registry.retireWriteOperation(boundedRoute.ptyId, 'input-1')
    await expect(
      registry.writeWithSettlement(boundedRoute.ptyId, 'second', { operationId: 'input-2' })
    ).resolves.toBe(true)
    registry.dispose()
  })

  it('rejects routes from a different provider generation', () => {
    const { client } = createClient()
    const registry = new SshPtyOwnershipTransferRouteRegistry(
      client as unknown as SshPtyOwnershipTransferClient,
      7,
      { onTransportLost: () => () => {} }
    )
    expect(() => registry.install(route(8))).toThrow('pty_ownership_transfer_route_invalid')
    registry.dispose()
  })
})

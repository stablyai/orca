import { describe, expect, it, vi } from 'vitest'
import type { PtyDataEvent } from './pty-provider-events'
import type { PtyProcessInfo } from './pty-process-info'
import { RuntimePtyOwnershipTransferProviderLifecycle } from './runtime-pty-ownership-transfer-provider-lifecycle'
import {
  RuntimePtySourceAuthorityRegistry,
  type RuntimePtySourceAuthorityRecord
} from './runtime-pty-source-authority-registry'

type ExitEvent = { id: string; code: number; incarnationId?: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled
    reject = rejected
  })
  return { promise, resolve, reject }
}

function providerEvents(inventory = deferred<PtyProcessInfo[]>()) {
  let data: ((event: PtyDataEvent) => void) | null = null
  let exit: ((event: ExitEvent) => void) | null = null
  return {
    provider: {
      listProcesses: vi.fn(() => inventory.promise),
      onData: (listener: (event: PtyDataEvent) => void) => {
        data = listener
        return () => {
          data = null
        }
      },
      onExit: (listener: (event: ExitEvent) => void) => {
        exit = listener
        return () => {
          exit = null
        }
      }
    },
    inventory,
    emitData: (event: PtyDataEvent) => data?.(event),
    emitExit: (event: ExitEvent) => exit?.(event)
  }
}

function setup() {
  const durable = new Map<string, RuntimePtySourceAuthorityRecord>()
  let lease = 0
  const registry = new RuntimePtySourceAuthorityRegistry({
    store: {
      loadAll: () => [...durable.values()],
      replaceAll: (records) => {
        durable.clear()
        for (const record of records) {
          durable.set(record.terminalId, record)
        }
      }
    },
    mintOwnerLease: () => `lease-${++lease}`
  })
  const adapter = {
    beginProviderReplacement: vi.fn(),
    observeOutput: vi.fn(),
    observeExit: vi.fn(),
    restoreInputFences: vi.fn(() => 0)
  }
  const errors: unknown[] = []
  const lifecycle = new RuntimePtyOwnershipTransferProviderLifecycle(registry, adapter, {
    onError: (error) => errors.push(error)
  })
  return { registry, adapter, errors, lifecycle }
}

describe('RuntimePtyOwnershipTransferProviderLifecycle', () => {
  it('fences superseded events and late inventories across a provider swap', async () => {
    const { registry, adapter, lifecycle } = setup()
    const first = providerEvents()
    const firstReplacement = lifecycle.replaceProvider(first.provider)
    first.emitData({
      id: 'pty-1',
      incarnationId: 'incarnation-1',
      data: 'first',
      seq: 1,
      sequenceChars: 5
    })
    const authority = registry.resolve('pty-1')
    expect(authority).toMatchObject({ ownerLease: 'lease-1', sourceOwnerGeneration: 1 })

    const second = providerEvents()
    const secondReplacement = lifecycle.replaceProvider(second.provider)
    expect(registry.resolve('pty-1')).toBeNull()
    first.emitData({ id: 'pty-1', incarnationId: 'incarnation-1', data: 'stale' })
    expect(adapter.observeOutput).toHaveBeenCalledTimes(1)

    first.inventory.resolve([])
    await expect(firstReplacement).resolves.toMatchObject({ state: 'superseded' })
    expect(registry.resolve('pty-1')).toBeNull()

    second.emitData({
      id: 'pty-1',
      incarnationId: 'incarnation-1',
      data: 'current',
      seq: 2,
      sequenceChars: 7
    })
    expect(registry.resolve('pty-1')).toEqual(authority)
    second.inventory.resolve([
      { id: 'pty-1', incarnationId: 'incarnation-1', cwd: '/workspace', title: 'shell' }
    ])
    await expect(secondReplacement).resolves.toEqual({
      generation: 2,
      state: 'current',
      authorities: 1
    })
    expect(adapter.beginProviderReplacement).toHaveBeenCalledTimes(2)
    expect(adapter.restoreInputFences).toHaveBeenCalledOnce()
  })

  it('merges output and exact exit events over an in-flight inventory snapshot', async () => {
    const { registry, adapter, lifecycle } = setup()
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.emitData({ id: 'pty-new', incarnationId: 'incarnation-new', data: 'spawned' })
    events.emitExit({ id: 'pty-old', incarnationId: 'incarnation-old', code: 0 })
    events.inventory.resolve([
      { id: 'pty-old', incarnationId: 'incarnation-old', cwd: '/old', title: 'old' }
    ])

    await expect(replacement).resolves.toMatchObject({ state: 'current', authorities: 1 })
    expect(registry.resolve('pty-old')).toBeNull()
    expect(registry.resolve('pty-new')).toMatchObject({ incarnationId: 'incarnation-new' })
    expect(adapter.observeExit).toHaveBeenCalledWith({
      terminalId: 'pty-old',
      incarnationId: 'incarnation-old',
      code: 0
    })
  })

  it('deactivates event authority when current inventory is ambiguous', async () => {
    const { registry, errors, lifecycle } = setup()
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.emitData({ id: 'pty-1', incarnationId: 'incarnation-1', data: 'current' })
    expect(registry.resolve('pty-1')).not.toBeNull()
    events.inventory.resolve([
      { id: 'pty-1', incarnationId: 'incarnation-1', cwd: '/one', title: 'one' },
      { id: 'pty-1', incarnationId: 'incarnation-1', cwd: '/two', title: 'two' }
    ])

    await expect(replacement).resolves.toMatchObject({ state: 'unverifiable' })
    expect(registry.resolve('pty-1')).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('fails closed when one provider generation emits two incarnations for one PTY id', async () => {
    const { registry, adapter, errors, lifecycle } = setup()
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.emitData({ id: 'pty-1', incarnationId: 'incarnation-1', data: 'old' })
    events.emitData({ id: 'pty-1', incarnationId: 'incarnation-2', data: 'new' })

    events.inventory.resolve([
      { id: 'pty-1', incarnationId: 'incarnation-2', cwd: '/workspace', title: 'shell' }
    ])

    await expect(replacement).resolves.toMatchObject({ state: 'unverifiable' })
    expect(registry.resolve('pty-1')).toBeNull()
    expect(adapter.observeOutput).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('ignores an exit for an older incarnation without retiring current authority', async () => {
    const { registry, adapter, lifecycle } = setup()
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.emitData({ id: 'pty-1', incarnationId: 'incarnation-1', data: 'current' })
    events.inventory.resolve([
      { id: 'pty-1', incarnationId: 'incarnation-1', cwd: '/workspace', title: 'shell' }
    ])
    await expect(replacement).resolves.toMatchObject({ state: 'current' })

    events.emitExit({ id: 'pty-1', incarnationId: 'incarnation-old', code: 0 })

    expect(registry.resolve('pty-1')).not.toBeNull()
    expect(adapter.observeExit).not.toHaveBeenCalled()
  })

  it('fails closed and reports inventory loss without treating it as process exit', async () => {
    const { registry, errors, lifecycle } = setup()
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.inventory.reject(new Error('daemon-unreachable'))

    await expect(replacement).resolves.toMatchObject({ state: 'unverifiable' })
    expect(registry.resolve('pty-1')).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('fails closed when durable input fences cannot be restored', async () => {
    const { registry, adapter, errors, lifecycle } = setup()
    vi.mocked(adapter.restoreInputFences).mockImplementationOnce(() => {
      throw new Error('input-fence-unavailable')
    })
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.inventory.resolve([
      { id: 'pty-1', incarnationId: 'incarnation-1', cwd: '/workspace', title: 'shell' }
    ])

    await expect(replacement).resolves.toMatchObject({ state: 'unverifiable' })
    expect(registry.resolve('pty-1')).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('deactivates event-derived authority when the inventory fails', async () => {
    const { registry, errors, lifecycle } = setup()
    const events = providerEvents()
    const replacement = lifecycle.replaceProvider(events.provider)
    events.emitData({ id: 'pty-1', incarnationId: 'incarnation-1', data: 'current' })
    expect(registry.resolve('pty-1')).not.toBeNull()

    events.inventory.reject(new Error('daemon-unreachable'))

    await expect(replacement).resolves.toMatchObject({ state: 'unverifiable' })
    expect(registry.resolve('pty-1')).toBeNull()
    expect(errors).toHaveLength(1)
  })
})

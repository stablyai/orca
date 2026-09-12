import { describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from './pty-provider-contract'
import {
  applyRuntimePtyOwnershipTransferProviderControl,
  type RuntimePtyOwnershipTransferControlProvider
} from './runtime-pty-ownership-transfer-provider-control'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime-destination'
} as const

function sourceProcess(incarnationId: string = identity.incarnationId): PtyProcessInfo {
  return { id: identity.terminalId, incarnationId, cwd: '/workspace', title: 'shell' }
}

function createProvider(initialInventory: PtyProcessInfo[] = [sourceProcess()]) {
  let inventory = initialInventory
  const provider: RuntimePtyOwnershipTransferControlProvider = {
    listProcesses: vi.fn(async () => inventory),
    resize: vi.fn(),
    getAppliedSize: vi.fn(async () => ({ cols: 120, rows: 40 })),
    sendSignal: vi.fn(async () => {}),
    clearBuffer: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {
      inventory = []
    })
  }
  return {
    provider,
    setInventory: (next: PtyProcessInfo[]) => {
      inventory = next
    }
  }
}

describe('applyRuntimePtyOwnershipTransferProviderControl', () => {
  it('applies resize only after exact incarnation and size readback', async () => {
    const { provider } = createProvider()

    await expect(
      applyRuntimePtyOwnershipTransferProviderControl({
        provider,
        isCurrentProvider: () => true,
        identity,
        control: { kind: 'resize', cols: 120, rows: 40 }
      })
    ).resolves.toBe('applied')
    expect(provider.resize).toHaveBeenCalledWith(identity.terminalId, 120, 40)
    expect(provider.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('refuses to mutate a stale provider or superseded incarnation', async () => {
    const stale = createProvider()
    await expect(
      applyRuntimePtyOwnershipTransferProviderControl({
        provider: stale.provider,
        isCurrentProvider: () => false,
        identity,
        control: { kind: 'resize', cols: 120, rows: 40 }
      })
    ).resolves.toBe('unverifiable')
    expect(stale.provider.resize).not.toHaveBeenCalled()

    const superseded = createProvider([sourceProcess('incarnation-2')])
    await expect(
      applyRuntimePtyOwnershipTransferProviderControl({
        provider: superseded.provider,
        isCurrentProvider: () => true,
        identity,
        control: { kind: 'shutdown', immediate: false }
      })
    ).resolves.toBe('unverifiable')
    expect(superseded.provider.shutdown).not.toHaveBeenCalled()
  })

  it('keeps resize unverifiable when provider generation changes during readback', async () => {
    const { provider } = createProvider()
    let current = true
    vi.mocked(provider.getAppliedSize!).mockImplementation(async () => {
      current = false
      return { cols: 120, rows: 40 }
    })

    await expect(
      applyRuntimePtyOwnershipTransferProviderControl({
        provider,
        isCurrentProvider: () => current,
        identity,
        control: { kind: 'resize', cols: 120, rows: 40 }
      })
    ).resolves.toBe('unverifiable')
  })

  it('reports shutdown applied only after the current provider proves absence', async () => {
    const { provider } = createProvider()

    await expect(
      applyRuntimePtyOwnershipTransferProviderControl({
        provider,
        isCurrentProvider: () => true,
        identity,
        control: { kind: 'shutdown', immediate: true }
      })
    ).resolves.toBe('applied')
    expect(provider.shutdown).toHaveBeenCalledWith(identity.terminalId, {
      immediate: true,
      keepHistory: true
    })
  })

  it.each([
    [{ kind: 'sendSignal', signal: 'SIGINT' } as const, 'sendSignal'],
    [{ kind: 'clearBuffer' } as const, 'clearBuffer']
  ])('does not promote %s without authoritative readback', async (control, method) => {
    const { provider } = createProvider()

    await expect(
      applyRuntimePtyOwnershipTransferProviderControl({
        provider,
        isCurrentProvider: () => true,
        identity,
        control
      })
    ).resolves.toBe('unverifiable')
    expect(provider[method]).toHaveBeenCalled()
  })
})

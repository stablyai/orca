import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../../shared/pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION } from '../../shared/pty-ownership-transfer-source-grant'
import type { PtyDataEvent } from './pty-provider-events'
import type { PtyProcessInfo } from './pty-process-info'
import {
  RuntimePtyOwnershipTransferReadOnlySource,
  runtimePtyOwnershipTransferReadOnlyStatePaths,
  startRuntimePtyOwnershipTransferProviderReconciliation
} from './runtime-pty-ownership-transfer-read-only-source'
import { RuntimePtyOwnershipTransferSourceAdapter } from './runtime-pty-ownership-transfer-source-adapter'
import { RuntimePtySourceAuthorityFileStore } from './runtime-pty-source-authority-file-store'
import { RuntimePtySourceAuthorityRegistry } from './runtime-pty-source-authority-registry'

type ExitEvent = { id: string; code: number; incarnationId?: string }

const sourceIdentity = {
  terminalId: 'local-pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1
} as const

const transferIdentity = {
  bridgeId: 'bridge-1',
  ...sourceIdentity,
  destinationRuntimeId: 'runtime-destination'
} as const

let stateDirectory: string

beforeEach(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'orca-runtime-pty-read-only-'))
})

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled
    reject = rejected
  })
  return { promise, resolve, reject }
}

function providerWithInventory(readInventory: () => Promise<PtyProcessInfo[]>) {
  const dataListeners = new Set<(event: PtyDataEvent) => void>()
  const exitListeners = new Set<(event: ExitEvent) => void>()
  const setInputFenced = vi.fn()
  const writeOwnershipTransferInput = vi.fn(() => true)
  const resize = vi.fn()
  const sendSignal = vi.fn(async () => {})
  const clearBuffer = vi.fn(async () => {})
  const shutdown = vi.fn(async () => {})
  const getAppliedSize = vi.fn(async () => ({ cols: 120, rows: 40 }))
  return {
    provider: {
      listProcesses: vi.fn(readInventory),
      setInputFenced,
      writeOwnershipTransferInput,
      resize,
      sendSignal,
      clearBuffer,
      shutdown,
      getAppliedSize,
      onData: (listener: (event: PtyDataEvent) => void) => {
        dataListeners.add(listener)
        return () => dataListeners.delete(listener)
      },
      onExit: (listener: (event: ExitEvent) => void) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      }
    },
    listenerCounts: () => ({ data: dataListeners.size, exit: exitListeners.size }),
    setInputFenced,
    writeOwnershipTransferInput,
    resize,
    sendSignal,
    clearBuffer,
    shutdown,
    emitData: (event: PtyDataEvent) => {
      for (const listener of dataListeners) {
        listener(event)
      }
    },
    emitExit: (event: ExitEvent) => {
      for (const listener of exitListeners) {
        listener(event)
      }
    }
  }
}

function exactInventory(): PtyProcessInfo[] {
  return [
    {
      id: sourceIdentity.terminalId,
      incarnationId: sourceIdentity.incarnationId,
      cwd: '/workspace',
      title: 'shell'
    }
  ]
}

function seedSourceAuthority(): {
  paths: ReturnType<typeof runtimePtyOwnershipTransferReadOnlyStatePaths>
  registry: RuntimePtySourceAuthorityRegistry
} {
  const paths = runtimePtyOwnershipTransferReadOnlyStatePaths(stateDirectory)
  const registry = new RuntimePtySourceAuthorityRegistry({
    store: new RuntimePtySourceAuthorityFileStore(paths.authorityFile),
    mintOwnerLease: () => sourceIdentity.ownerLease
  })
  expect(registry.admit(sourceIdentity.terminalId, sourceIdentity.incarnationId)).toEqual({
    version: 1,
    ...sourceIdentity
  })
  return { paths, registry }
}

function seedPreparedTransfer(): void {
  const { paths, registry } = seedSourceAuthority()
  const adapter = new RuntimePtyOwnershipTransferSourceAdapter({
    mutationEnabled: () => true,
    authorizeMutationRequest: () => true,
    store: new RelayPtyOwnershipTransferFileStore(paths.transferDirectory),
    resolveSource: (terminalId) => registry.resolve(terminalId),
    setInputFenced: vi.fn(),
    writeDestinationInput: vi.fn(),
    publishDestinationOutput: vi.fn(),
    applyDestinationControl: vi.fn(async () => 'applied' as const),
    publishDestinationExit: vi.fn()
  })
  adapter.prepare(
    {
      ...transferIdentity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      surfacePublication: {
        version: 1,
        surfaceBinding: {
          executionHostId: 'local',
          workspaceKey: 'folder:workspace-1',
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          ptyId: sourceIdentity.terminalId
        }
      }
    },
    { clientId: 1, transportGeneration: 1, isStale: () => false }
  )
}

describe('RuntimePtyOwnershipTransferReadOnlySource', () => {
  it('reconciles one exact provider generation and exposes no mutation surface', async () => {
    const source = new RuntimePtyOwnershipTransferReadOnlySource({ stateDirectory })
    const current = providerWithInventory(async () => exactInventory())

    await expect(source.reconcileProvider(current.provider)).resolves.toEqual({
      generation: 1,
      state: 'current',
      authorities: 1
    })
    await expect(source.reconcileProvider(current.provider)).resolves.toEqual({
      generation: 1,
      state: 'current',
      authorities: 1
    })

    expect(current.provider.listProcesses).toHaveBeenCalledOnce()
    expect(current.listenerCounts()).toEqual({ data: 1, exit: 1 })
    expect(source.getOwnershipBridgeCapabilities()).toMatchObject({
      liveTransfer: false,
      destinationControl: true,
      postCommitReplay: true,
      statusQuery: true
    })
    expect('prepare' in source).toBe(false)
  })

  it('shares concurrent reconciliation instead of creating duplicate listeners', async () => {
    const source = new RuntimePtyOwnershipTransferReadOnlySource({ stateDirectory })
    const inventory = deferred<PtyProcessInfo[]>()
    const current = providerWithInventory(() => inventory.promise)

    const first = source.reconcileProvider(current.provider)
    const second = source.reconcileProvider(current.provider)
    expect(second).toBe(first)
    inventory.resolve(exactInventory())

    await expect(first).resolves.toMatchObject({ state: 'current', authorities: 1 })
    expect(current.provider.listProcesses).toHaveBeenCalledOnce()
    expect(current.listenerCounts()).toEqual({ data: 1, exit: 1 })
  })

  it('composes the provider control route only when both explicit mutation gates open', async () => {
    seedSourceAuthority()
    const source = new RuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory,
      mutationEnabled: () => true,
      authorizeMutationRequest: () => true
    })
    const current = providerWithInventory(async () => exactInventory())
    await source.reconcileProvider(current.provider)
    const adapter = source.getMutationSource()
    const binding = { clientId: 7, transportGeneration: 2, isStale: () => false }

    expect(source.getOwnershipBridgeCapabilities()).toMatchObject({
      liveTransfer: true,
      destinationControl: true,
      postCommitReplay: true
    })
    adapter.prepare({ ...transferIdentity, version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION }, binding)
    adapter.commit(
      {
        ...transferIdentity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        acceptedSourceEndSeq: 0,
        receipt: {
          receiptId: 'receipt-1',
          bridgeId: transferIdentity.bridgeId,
          acceptedSourceEndSeq: 0,
          committedAt: '2026-08-31T00:00:00.000Z'
        }
      },
      binding
    )
    adapter.attachDestination(
      {
        ...transferIdentity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId: 'attachment-1'
      },
      binding
    )

    await expect(
      adapter.controlDestination(
        {
          ...transferIdentity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          attachmentId: 'attachment-1',
          controlId: 'resize-1',
          control: { kind: 'resize', cols: 120, rows: 40 }
        },
        binding
      )
    ).resolves.toMatchObject({ outcome: 'applied', duplicate: false })
    expect(current.resize).toHaveBeenCalledWith(sourceIdentity.terminalId, 120, 40)
  })

  it('authenticates exact host authority and rejects stale, self-targeted, or stale-socket requests', async () => {
    seedSourceAuthority()
    let source: RuntimePtyOwnershipTransferReadOnlySource | null = null
    source = new RuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory,
      runtimeId: 'runtime-source',
      mutationEnabled: () => true,
      authorizeMutationRequest: (method, request, binding) =>
        source?.authorizeMutationRequest(method, request, binding) ?? false
    })
    const current = providerWithInventory(async () => exactInventory())
    await source.reconcileProvider(current.provider)
    const binding = {
      clientId: 17,
      transportGeneration: 2,
      pairedDeviceId: 'paired-device-1',
      isStale: () => false
    }
    const grant = source.issueOwnershipTransferSourceGrant(
      {
        version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
        terminalId: sourceIdentity.terminalId,
        destinationRuntimeId: transferIdentity.destinationRuntimeId,
        surfaceBinding: {
          executionHostId: 'local',
          workspaceKey: 'folder:workspace-1',
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          ptyId: sourceIdentity.terminalId
        }
      },
      binding
    )
    const valid = {
      ...grant.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      surfacePublication: { version: 1 as const, surfaceBinding: grant.surfaceBinding }
    }

    expect(
      source.authorizeMutationRequest('pty.ownershipTransfer.prepareSource', valid, binding)
    ).toBe(true)
    expect(
      source.authorizeMutationRequest(
        'pty.ownershipTransfer.prepareSource',
        { ...valid, ownerLease: 'stale-lease' },
        binding
      )
    ).toBe(false)
    expect(
      source.authorizeMutationRequest(
        'pty.ownershipTransfer.prepareSource',
        { ...valid, destinationRuntimeId: 'runtime-source' },
        binding
      )
    ).toBe(false)
    expect(
      source.authorizeMutationRequest('pty.ownershipTransfer.prepareSource', valid, {
        ...binding,
        isStale: () => true
      })
    ).toBe(false)
    expect(source.getOwnershipTransferSourceIdentity(sourceIdentity.terminalId)).toMatchObject(
      sourceIdentity
    )
  })

  it('routes local input, resize, signal, clear, output, and host-positive exit through the fenced provider', async () => {
    const { registry } = seedSourceAuthority()
    const current = providerWithInventory(async () => exactInventory())
    const source = new RuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory,
      runtimeId: 'runtime-source',
      mutationEnabled: () => true,
      authorizeMutationRequest: () => true
    })
    await source.reconcileProvider(current.provider)
    const authority = registry.resolve(sourceIdentity.terminalId)!
    const identity = {
      bridgeId: 'bridge-local-controls',
      terminalId: authority.terminalId,
      incarnationId: authority.incarnationId,
      ownerLease: authority.ownerLease,
      sourceOwnerGeneration: authority.sourceOwnerGeneration,
      destinationRuntimeId: 'runtime-destination'
    }
    const binding = { clientId: 9, transportGeneration: 1, isStale: () => false }
    const adapter = source.getMutationSource()
    adapter.prepare({ ...identity, version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION }, binding)
    adapter.commit(
      {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        acceptedSourceEndSeq: 0,
        receipt: {
          receiptId: 'receipt-local-controls',
          bridgeId: identity.bridgeId,
          acceptedSourceEndSeq: 0,
          committedAt: '2026-08-31T00:00:00.000Z'
        }
      },
      binding
    )
    adapter.attachDestination(
      {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId: 'attachment-local-controls'
      },
      binding
    )
    const outputs: unknown[] = []
    const exits: unknown[] = []
    source.onDestinationOutput((event) => outputs.push(event))
    source.onDestinationExit((event) => exits.push(event))

    expect(
      adapter.acceptInput(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          inputId: 'input-local-1',
          data: 'echo local\n'
        },
        binding
      )
    ).toEqual({ accepted: true, duplicate: false })
    expect(current.writeOwnershipTransferInput).toHaveBeenCalledWith(
      sourceIdentity.terminalId,
      'echo local\n'
    )
    await expect(
      adapter.controlDestination(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          attachmentId: 'attachment-local-controls',
          controlId: 'resize-local-1',
          control: { kind: 'resize', cols: 120, rows: 40 }
        },
        binding
      )
    ).resolves.toMatchObject({ outcome: 'applied' })
    await expect(
      adapter.controlDestination(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          attachmentId: 'attachment-local-controls',
          controlId: 'signal-local-1',
          control: { kind: 'sendSignal', signal: 'SIGINT' }
        },
        binding
      )
    ).resolves.toMatchObject({ outcome: 'unverifiable' })
    await expect(
      adapter.controlDestination(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          attachmentId: 'attachment-local-controls',
          controlId: 'clear-local-1',
          control: { kind: 'clearBuffer' }
        },
        binding
      )
    ).resolves.toMatchObject({ outcome: 'unverifiable' })
    expect(current.resize).toHaveBeenCalledWith(sourceIdentity.terminalId, 120, 40)
    expect(current.sendSignal).toHaveBeenCalledWith(sourceIdentity.terminalId, 'SIGINT')
    expect(current.clearBuffer).toHaveBeenCalledWith(sourceIdentity.terminalId)

    current.emitData({
      id: sourceIdentity.terminalId,
      incarnationId: sourceIdentity.incarnationId,
      data: 'remote output'
    })
    expect(outputs).toEqual([
      expect.objectContaining({
        identity,
        attachmentId: 'attachment-local-controls',
        frame: { seq: 1, data: 'remote output' }
      })
    ])
    current.emitExit({
      id: sourceIdentity.terminalId,
      incarnationId: sourceIdentity.incarnationId,
      code: 0
    })
    expect(exits).toEqual([
      expect.objectContaining({
        bridgeId: identity.bridgeId,
        terminalId: identity.terminalId,
        incarnationId: identity.incarnationId,
        ownerLease: identity.ownerLease,
        sourceOwnerGeneration: identity.sourceOwnerGeneration,
        destinationRuntimeId: identity.destinationRuntimeId,
        attachmentId: 'attachment-local-controls',
        exit: expect.objectContaining({ verdict: 'exited', code: 0 })
      })
    ])
    expect(current.setInputFenced).toHaveBeenCalledWith(sourceIdentity.terminalId, true)
    expect(current.setInputFenced).toHaveBeenCalledTimes(1)
  })

  it('reconciles the current provider and each installed replacement automatically', async () => {
    const source = new RuntimePtyOwnershipTransferReadOnlySource({ stateDirectory })
    const first = providerWithInventory(async () => exactInventory())
    const second = providerWithInventory(async () => exactInventory())
    let current = first.provider
    const subscription: {
      notifyReplacement?: (provider: typeof first.provider) => void
    } = {}
    const unsubscribe = await startRuntimePtyOwnershipTransferProviderReconciliation({
      source,
      getProvider: () => current,
      subscribe: (listener) => {
        subscription.notifyReplacement = listener
        return () => {
          delete subscription.notifyReplacement
        }
      }
    })

    current = second.provider
    subscription.notifyReplacement?.(second.provider)
    await source.reconcileProvider(second.provider)

    expect(first.provider.listProcesses).toHaveBeenCalledOnce()
    expect(first.listenerCounts()).toEqual({ data: 0, exit: 0 })
    expect(second.provider.listProcesses).toHaveBeenCalledOnce()
    expect(second.listenerCounts()).toEqual({ data: 1, exit: 1 })

    unsubscribe()
    expect(subscription.notifyReplacement).toBeUndefined()
  })

  it('serves exact durable status after authority is reproven by the current provider', async () => {
    seedPreparedTransfer()
    const source = new RuntimePtyOwnershipTransferReadOnlySource({ stateDirectory })
    const current = providerWithInventory(async () => exactInventory())
    await source.reconcileProvider(current.provider)

    expect(
      source.getOwnershipTransferStatus({
        ...transferIdentity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
      })
    ).toMatchObject({
      ...transferIdentity,
      phase: 'prepared'
    })
    expect(source.getOwnershipBridgeCapabilities().liveTransfer).toBe(false)
    expect(current.setInputFenced).toHaveBeenCalledWith(sourceIdentity.terminalId, true)
  })

  it('keeps recovered authority unverifiable when the provider cannot fence input', async () => {
    seedPreparedTransfer()
    const errors: unknown[] = []
    const source = new RuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory,
      onError: (error) => errors.push(error)
    })
    const current = providerWithInventory(async () => exactInventory())
    delete (current.provider as Partial<typeof current.provider>).setInputFenced

    await expect(source.reconcileProvider(current.provider)).resolves.toMatchObject({
      state: 'unverifiable',
      authorities: 0
    })
    expect(errors).toHaveLength(1)
  })

  it('retries an unverifiable inventory without treating contact loss as exit', async () => {
    const errors: unknown[] = []
    const source = new RuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory,
      onError: (error) => errors.push(error)
    })
    const inventory = vi
      .fn<() => Promise<PtyProcessInfo[]>>()
      .mockRejectedValueOnce(new Error('provider-unreachable'))
      .mockResolvedValueOnce(exactInventory())
    const current = providerWithInventory(inventory)

    await expect(source.reconcileProvider(current.provider)).resolves.toMatchObject({
      generation: 1,
      state: 'unverifiable',
      authorities: 0
    })
    await expect(source.reconcileProvider(current.provider)).resolves.toMatchObject({
      generation: 2,
      state: 'current',
      authorities: 1
    })

    expect(inventory).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
    expect(current.listenerCounts()).toEqual({ data: 1, exit: 1 })
  })

  it('fences a superseded provider generation during replacement', async () => {
    const source = new RuntimePtyOwnershipTransferReadOnlySource({ stateDirectory })
    const firstInventory = deferred<PtyProcessInfo[]>()
    const first = providerWithInventory(() => firstInventory.promise)
    const firstReconciliation = source.reconcileProvider(first.provider)
    const second = providerWithInventory(async () => exactInventory())

    await expect(source.reconcileProvider(second.provider)).resolves.toMatchObject({
      generation: 2,
      state: 'current'
    })
    firstInventory.resolve(exactInventory())
    await expect(firstReconciliation).resolves.toMatchObject({
      generation: 1,
      state: 'superseded'
    })
    expect(first.listenerCounts()).toEqual({ data: 0, exit: 0 })
    expect(second.listenerCounts()).toEqual({ data: 1, exit: 1 })
  })
})

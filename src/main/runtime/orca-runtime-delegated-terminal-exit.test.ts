import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import {
  identity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { OrcadDelegatedExitEvent } from '../orcad/orcad-delegated-exit-delivery'
import { getProviderForPty } from '../ipc/pty/provider/registry'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-delegated-exit-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function setup() {
  const store = createStore()
  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId: identity.destinationRuntimeId
  })
  runtime.installPtyOwnershipTransferDestinationOutputBridge()
  const binding = preparation.surfacePublication.surfaceBinding
  runtime.registerPty(binding.ptyId, binding.workspaceKey, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId: identity.incarnationId
  })
  const prepared = runtime.getPtyOwnershipTransferDestinationRegistry()!.prepareDelegated(
    {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
      surfacePublication: preparation.surfacePublication
    },
    {
      version: 1,
      proof: request(),
      endpoint: '/incumbent.sock',
      incumbentVersion: 'test',
      endpointCredential: 'test'
    }
  )
  const receipt = {
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00Z'
  }
  prepared.adapter.commit(receipt)
  prepared.adapter.publish()
  const claim = { generation: 1, claimId: 'claim-1' }
  prepared.adapter.bindDelegatedExecution(claim)
  const snapshot = prepared.adapter.acceptDelegatedExecutionStatus({
    ...identity,
    version: 1,
    phase: 'committed',
    receipt,
    destinationClaim: claim,
    boundToConnection: true,
    executionVerdict: 'exited',
    sourceOutputEndSeq: 0,
    exit: { verdict: 'exited', code: 17, eventId: 'exit-1', observedAt: receipt.committedAt }
  })
  const event: OrcadDelegatedExitEvent = {
    identity,
    exit: snapshot.exit!,
    surfaceBinding: binding,
    destinationClaim: claim,
    finalOutputSeq: 0
  }
  const onExit = vi.spyOn(runtime, 'onPtyExit')
  return { runtime, store, ...prepared, event, onExit }
}

it('retires the real runtime terminal through its host-confirmed exit path exactly once', () => {
  const f = setup()
  f.runtime.acceptDelegatedPtyExit(f.event)
  f.runtime.acceptDelegatedPtyExit(f.event)
  expect(f.outputOutbox.loadRetirement(identity)?.phase).toBe('applied')
  expect(f.onExit).toHaveBeenCalledExactlyOnceWith(
    identity.terminalId,
    17,
    identity.incarnationId,
    {
      hostExitConfirmed: true,
      providerExitObserved: true
    }
  )
})

it.each(['prepared', 'applied'] as const)(
  'retries an uncertain %s receipt save without repeating completed runtime cleanup',
  (phase) => {
    const f = setup()
    const record = f.outputOutbox.recordRetirement.bind(f.outputOutbox)
    let failed = false
    vi.spyOn(f.outputOutbox, 'recordRetirement').mockImplementation((target, value) => {
      record(target, value)
      if (!failed && (value as { phase: string }).phase === phase) {
        failed = true
        throw new Error('uncertain receipt write')
      }
    })
    expect(() => f.runtime.acceptDelegatedPtyExit(f.event)).toThrow('uncertain receipt write')
    expect(f.onExit).toHaveBeenCalledTimes(phase === 'prepared' ? 0 : 1)
    f.runtime.acceptDelegatedPtyExit(f.event)
    expect(f.onExit).toHaveBeenCalledOnce()
    expect(f.outputOutbox.loadRetirement(identity)?.phase).toBe('applied')
  }
)

it('fences synchronous reentrant retirement and allows retry when dispatch fails', () => {
  const f = setup()
  f.onExit.mockImplementationOnce(() => {
    f.runtime.acceptDelegatedPtyExit(f.event)
    throw new Error('dispatch failed')
  })
  expect(() => f.runtime.acceptDelegatedPtyExit(f.event)).toThrow('dispatch failed')
  expect(f.onExit).toHaveBeenCalledOnce()
  f.runtime.acceptDelegatedPtyExit(f.event)
  expect(f.onExit).toHaveBeenCalledTimes(2)
})

it.each(['claim', 'surface', 'exit', 'pending-output', 'incarnation'])(
  'refuses %s mismatch before runtime retirement',
  (mode) => {
    const f = setup()
    let event = f.event
    if (mode === 'claim') {
      event = { ...event, destinationClaim: { generation: 2, claimId: 'other' } }
    }
    if (mode === 'surface') {
      event = { ...event, surfaceBinding: { ...event.surfaceBinding, tabId: 'other' } }
    }
    if (mode === 'exit') {
      event = { ...event, exit: { ...event.exit, code: 99 } }
    }
    if (mode === 'pending-output') {
      f.outputOutbox.enqueue(identity, { seq: 1, data: 'tail' })
    }
    if (mode === 'incarnation') {
      f.runtime.registerPty(identity.terminalId, event.surfaceBinding.workspaceKey, null, {
        tabId: event.surfaceBinding.tabId,
        leafId: event.surfaceBinding.leafId,
        incarnationId: 'replacement'
      })
    }
    expect(() => f.runtime.acceptDelegatedPtyExit(event)).toThrow()
    expect(f.onExit).not.toHaveBeenCalled()
  }
)

it.each(['prepared', 'applied'] as const)(
  'recovers %s retirement without rebuilding an adapter',
  (phase) => {
    const f = setup()
    f.outputOutbox.recordRetirement(identity, { phase: 'prepared', event: f.event })
    if (phase === 'applied') {
      f.outputOutbox.recordRetirement(identity, { phase, event: f.event })
    }
    const runtime = new OrcaRuntimeService(createStore(), undefined, {
      runtimeId: identity.destinationRuntimeId
    })
    runtime.installPtyOwnershipTransferDestinationOutputBridge()
    const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
    expect(
      registry.recoverPersistedDelegatedDestinations(runtime.recoverDelegatedPtyRetirement)
    ).toEqual([])
    expect(registry.get(identity.bridgeId)).toBeNull()
    expect(f.outputOutbox.loadRetirement(identity)?.phase).toBe('applied')
    expect(
      createStore().getWorkspaceSession().terminalLayoutsByTabId[f.event.surfaceBinding.tabId]
    ).toBeUndefined()
    expect(() => getProviderForPty(identity.terminalId)).toThrow('exited')
    const topology = createStore().getWorkspaceSession().terminalTopologyRevisionByRepoId
    expect(
      registry.recoverPersistedDelegatedDestinations(runtime.recoverDelegatedPtyRetirement)
    ).toEqual([])
    expect(createStore().getWorkspaceSession().terminalTopologyRevisionByRepoId).toEqual(topology)
  }
)

it('keeps recovery prepared on workspace flush failure and completes after retry', () => {
  const f = setup()
  f.outputOutbox.recordRetirement(identity, { phase: 'prepared', event: f.event })
  const retirement = f.outputOutbox.loadRetirement(identity)!
  vi.spyOn(f.store, 'flushOrThrow').mockImplementationOnce(() => {
    throw new Error('cleanup flush failed')
  })
  expect(() =>
    f.runtime.recoverDelegatedPtyRetirement({ retirement, outbox: f.outputOutbox })
  ).toThrow('cleanup flush failed')
  expect(f.outputOutbox.loadRetirement(identity)?.phase).toBe('prepared')
  expect(f.onExit).not.toHaveBeenCalled()
  f.runtime.recoverDelegatedPtyRetirement({ retirement, outbox: f.outputOutbox })
  expect(f.outputOutbox.loadRetirement(identity)?.phase).toBe('applied')
  expect(f.onExit).toHaveBeenCalledOnce()
})

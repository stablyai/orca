import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import {
  identity as baseIdentity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  getDelegatedPtyProvider,
  hasDelegatedPtyProviderRoute
} from '../ipc/pty/provider/delegated-provider-routes'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-delegated-registration-'))
})
afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

function setup(workspaceKey: `folder:${string}` | `worktree:${string}` = 'folder:folder-1') {
  const identity = { ...baseIdentity, terminalId: randomUUID() }
  const binding = {
    ...preparation.surfacePublication.surfaceBinding,
    workspaceKey,
    ptyId: identity.terminalId
  }
  const runtime = new OrcaRuntimeService(createStore(), undefined, {
    runtimeId: identity.destinationRuntimeId
  })
  runtime.installPtyOwnershipTransferDestinationOutputBridge()
  const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
  const prepared = registry.prepareDelegated(
    {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
      surfacePublication: { version: 1, surfaceBinding: binding }
    },
    {
      version: 1,
      proof: { ...request(), ...identity },
      endpoint: '/not-contacted.sock',
      incumbentVersion: 'test',
      endpointCredential: 'test'
    }
  )
  const publish = () => {
    prepared.adapter.commit({
      bridgeId: identity.bridgeId,
      receiptId: 'receipt',
      acceptedSourceEndSeq: 0,
      committedAt: new Date().toISOString()
    })
    prepared.adapter.publish()
  }
  return { runtime, identity, binding, publish, ...prepared }
}

it.each(['folder:folder-1', 'worktree:repo/worktree'] as const)(
  'registers %s as unverifiable without native spawning',
  async (workspace) => {
    const f = setup(workspace)
    f.publish()
    const spawnRegistration = vi.spyOn(f.runtime, 'registerPty')
    f.runtime.registerPublishedDelegatedPty(f.identity)
    expect(spawnRegistration).not.toHaveBeenCalled()
    expect(f.runtime.getPtyLivenessVerdict(f.identity.terminalId)).toMatchObject({
      status: 'unverifiable'
    })
    expect(hasDelegatedPtyProviderRoute(f.identity.terminalId)).toBe(true)
    expect(() => f.runtime.assertPublishedDelegatedPtyReserved(f.identity)).not.toThrow()
    expect(() => getDelegatedPtyProvider(f.identity.terminalId)).toThrow('unverifiable')
    await expect(
      f.runtime.initializeDelegatedPtyOwnershipModel(f.identity)
    ).resolves.toBeUndefined()
    f.runtime.markPtyLivenessLive(f.identity.terminalId)
    f.runtime.registerPublishedDelegatedPty(f.identity)
    expect(f.runtime.getPtyLivenessVerdict(f.identity.terminalId)).toMatchObject({ status: 'live' })
  }
)

it('does not reserve a provider route before publication', () => {
  const f = setup()
  expect(() => f.runtime.registerPublishedDelegatedPty(f.identity)).toThrow(
    'publication_unavailable'
  )
  expect(hasDelegatedPtyProviderRoute(f.identity.terminalId)).toBe(false)
})

it('refuses degraded readiness before reserving a published terminal', () => {
  const f = setup()
  f.publish()
  expect(() => f.runtime.assertPublishedDelegatedPtyReserved(f.identity)).toThrow(
    'reservation_unavailable'
  )
})

it('projects only the current validated claim and never treats disconnect as exit', () => {
  const f = setup()
  f.publish()
  f.runtime.registerPublishedDelegatedPty(f.identity)
  const claim = { generation: 1, claimId: 'first' }
  f.adapter.bindDelegatedExecution(claim)
  f.adapter.acceptDelegatedExecutionStatus({
    ...f.identity,
    version: 1,
    phase: 'committed',
    receipt: f.adapter.snapshot().commitReceipt,
    destinationClaim: claim,
    boundToConnection: true,
    executionVerdict: 'live',
    sourceOutputEndSeq: 0
  })
  expect(f.runtime.acceptDelegatedPtyExecutionState(f.identity, claim)).toBe(true)
  expect(f.runtime.acceptDelegatedPtyExecutionState(f.identity, claim)).toBe(false)
  expect(f.runtime.getPtyLivenessVerdict(f.identity.terminalId)?.status).toBe('live')
  const replacement = { generation: 2, claimId: 'second' }
  f.adapter.bindDelegatedExecution(replacement)
  expect(() => f.runtime.acceptDelegatedPtyExecutionState(f.identity, claim)).toThrow(
    'execution_stale'
  )
  f.adapter.markDelegatedExecutionUnverifiable(replacement)
  const exit = vi.spyOn(f.runtime, 'onPtyExit')
  expect(f.runtime.acceptDelegatedPtyExecutionState(f.identity, replacement)).toBe(true)
  expect(f.runtime.acceptDelegatedPtyExecutionState(f.identity, replacement)).toBe(false)
  expect(f.runtime.getPtyLivenessVerdict(f.identity.terminalId)?.status).toBe('unverifiable')
  expect(exit).not.toHaveBeenCalled()
})

it('does not take over an existing ordinary local registration even with a matching surface', () => {
  const f = setup()
  f.publish()
  f.runtime.registerPty(f.identity.terminalId, f.binding.workspaceKey, null, {
    tabId: f.binding.tabId,
    leafId: f.binding.leafId,
    incarnationId: f.identity.incarnationId
  })
  expect(() => f.runtime.registerPublishedDelegatedPty(f.identity)).toThrow('registration_occupied')
  expect(hasDelegatedPtyProviderRoute(f.identity.terminalId)).toBe(false)
})

it('rejects a replaced incarnation without changing its route or verdict', () => {
  const f = setup()
  f.publish()
  f.runtime.registerPublishedDelegatedPty(f.identity)
  f.runtime.registerPty(f.identity.terminalId, f.binding.workspaceKey, null, {
    tabId: f.binding.tabId,
    leafId: f.binding.leafId,
    incarnationId: 'replacement'
  })
  f.runtime.markPtyLivenessLive(f.identity.terminalId)
  expect(() => f.runtime.registerPublishedDelegatedPty(f.identity)).toThrow('route_mismatch')
  expect(f.runtime.getPtyLivenessVerdict(f.identity.terminalId)).toMatchObject({ status: 'live' })
})

it('returns only the restored durable model without replaying output or advancing acknowledgements', async () => {
  const f = setup()
  f.outputOutbox.recordInitialModelSnapshot(f.identity, {
    version: 1,
    identity: f.identity,
    throughSeq: 0,
    modelSequenceEnd: 100,
    modelData: 'retained',
    cols: 80,
    rows: 24,
    restoreMetadata: { version: 1, pendingEscapeTailAnsi: '\x1b[' }
  })
  f.publish()
  f.runtime.registerPublishedDelegatedPty(f.identity)
  await expect(f.runtime.serializePublishedDelegatedPtyModel(f.identity)).resolves.toBeNull()
  await f.runtime.initializeDelegatedPtyOwnershipModel(f.identity)
  const accept = vi.spyOn(f.runtime, 'acceptPtyDataBounded')
  const before = f.outputOutbox.load(f.identity)
  const model = await f.runtime.serializePublishedDelegatedPtyModel(f.identity)
  expect(model).toMatchObject({
    seq: 100,
    source: 'headless',
    cols: 80,
    rows: 24,
    pendingEscapeTailAnsi: '\x1b['
  })
  expect(model?.data).toContain('retained')
  expect(accept).not.toHaveBeenCalled()
  expect(f.outputOutbox.load(f.identity)).toEqual(before)
})

it('withholds a snapshot when output arrives during serialization', async () => {
  const f = setup()
  f.publish()
  f.runtime.registerPublishedDelegatedPty(f.identity)
  await f.runtime.initializeDelegatedPtyOwnershipModel(f.identity)
  const serialize = f.runtime.serializeMainTerminalBuffer.bind(f.runtime)
  vi.spyOn(f.runtime, 'serializeMainTerminalBuffer').mockImplementation(async (...args) => {
    const result = await serialize(...args)
    f.outputOutbox.enqueue(f.identity, { seq: 1, data: 'new' })
    return result
  })
  await expect(f.runtime.serializePublishedDelegatedPtyModel(f.identity)).resolves.toBeNull()
})

it('withholds a snapshot when clear commits during serialization at unchanged cursors', async () => {
  const f = setup()
  const seed = {
    version: 1,
    identity: f.identity,
    throughSeq: 0,
    modelSequenceEnd: 100,
    modelData: 'history',
    cols: 80,
    rows: 24,
    restoreMetadata: { version: 1 as const }
  }
  f.outputOutbox.recordInitialModelSnapshot(f.identity, seed)
  f.publish()
  f.runtime.registerPublishedDelegatedPty(f.identity)
  await f.runtime.initializeDelegatedPtyOwnershipModel(f.identity)
  const serialize = f.runtime.serializeMainTerminalBuffer.bind(f.runtime)
  vi.spyOn(f.runtime, 'serializeMainTerminalBuffer').mockImplementationOnce(async (...args) => {
    const result = await serialize(...args)
    f.outputOutbox.recordModelClear(f.identity, {
      operationId: 'clear',
      expectedRevision: 0,
      throughSeq: 0,
      modelSequenceEnd: 100,
      model: { ...seed, modelData: '' }
    })
    return result
  })
  await expect(f.runtime.serializePublishedDelegatedPtyModel(f.identity)).resolves.toBeNull()
  expect(f.runtime.getPtyOutputSequence(f.identity.terminalId)).toBe(100)
})

it('rejects a snapshot when the catalog incarnation changes during serialization', async () => {
  const f = setup()
  f.publish()
  f.runtime.registerPublishedDelegatedPty(f.identity)
  await f.runtime.initializeDelegatedPtyOwnershipModel(f.identity)
  const serialize = f.runtime.serializeMainTerminalBuffer.bind(f.runtime)
  vi.spyOn(f.runtime, 'serializeMainTerminalBuffer').mockImplementation(async (...args) => {
    const result = await serialize(...args)
    f.runtime.registerPty(f.identity.terminalId, f.binding.workspaceKey, null, {
      tabId: f.binding.tabId,
      leafId: f.binding.leafId,
      incarnationId: 'replacement'
    })
    return result
  })
  await expect(f.runtime.serializePublishedDelegatedPtyModel(f.identity)).rejects.toThrow(
    'route_mismatch'
  )
})

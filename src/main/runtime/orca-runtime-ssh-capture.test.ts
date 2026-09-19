import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { createStore, testState } from '../persistence-test-harness'
import { getSshPtyAcceptedSourceCheckpoints } from '../ipc/ssh-pty-output-intake-registry'
import type * as IntakeRegistry from '../ipc/ssh-pty-output-intake-registry'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import {
  createSshPtyOutputIntakeHarness,
  sshPtyOutputEvent
} from '../ipc/ssh-pty-output-intake-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', async (original) => ({
  ...(await original<typeof IntakeRegistry>()),
  getSshPtyAcceptedSourceCheckpoints: vi.fn()
}))
const identity = {
  bridgeId: 'bridge',
  terminalId: 'relay-pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'host'
}
const route = { ptyId: toAppSshPtyId('target', identity.terminalId), providerGeneration: 42 }
const checkpoint = {
  id: route.ptyId,
  providerGeneration: 42,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation',
  deliveryToken: 'delivery',
  acceptedSourceEndSu: 100
}
const boundary = parsePtyOwnershipCaptureBoundary(
  {
    version: 1,
    identity,
    throughSeq: 20,
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      providerGeneration: 1,
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'delivery',
      state: 'active',
      windowSu: 256,
      receivedEndSu: 100,
      sentEndSu: 100,
      creditedEndSu: 100,
      generationClosed: false,
      exitPublished: false
    }
  },
  identity
)
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-ssh-capture-'))
  vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReset().mockReturnValue([checkpoint])
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function setup() {
  const runtime = new OrcaRuntimeService(createStore(), undefined, { runtimeId: 'desktop' })
  runtime.registerPty(route.ptyId, 'folder:folder-1', 'target', {
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    incarnationId: identity.incarnationId
  })
  const data = 'retained output\r\n\x1b[3'
  await runtime.acceptPtyDataBounded(route.ptyId, data, Date.now()).completion
  return { runtime, data }
}

const surface = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: identity.terminalId
}
function trackedModels(runtime: OrcaRuntimeService) {
  return (runtime as unknown as { headlessTerminals: Map<string, RuntimeHeadlessTerminal> })
    .headlessTerminals
}

it('settles the exact source model without disposing it or publishing exit', async () => {
  const { runtime } = await setup()
  const model = trackedModels(runtime).get(route.ptyId)!
  const exit = vi.spyOn(runtime, 'onPtyExit')
  const dispose = vi.spyOn(model.emulator, 'dispose')
  const result = await runtime.settleOutgoingSshPtyCatalogModels(
    'target',
    new AbortController().signal
  )
  result.assertCurrent()
  expect(trackedModels(runtime).get(route.ptyId)).toBe(model)
  expect(exit).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
})

it('waits for queued model writes before ownership settlement', async () => {
  const { runtime } = await setup()
  const model = trackedModels(runtime).get(route.ptyId)!
  const pending = Promise.withResolvers<void>()
  model.writeChain = pending.promise
  const ownership = vi.spyOn(model.ownership, 'settle')
  const settling = runtime.settleOutgoingSshPtyCatalogModels('target', new AbortController().signal)
  expect(ownership).not.toHaveBeenCalled()
  pending.resolve()
  const result = await settling
  expect(ownership).toHaveBeenCalledOnce()
  result.assertCurrent()
})

it.each(['model', 'write', 'output', 'abort'] as const)(
  'refuses %s drift during ownership settlement',
  async (change) => {
    const { runtime } = await setup()
    const models = trackedModels(runtime)
    const model = models.get(route.ptyId)!
    const pending = Promise.withResolvers<void>()
    const ownership = vi.spyOn(model.ownership, 'settle').mockReturnValue(pending.promise)
    const controller = new AbortController()
    const settling = runtime.settleOutgoingSshPtyCatalogModels('target', controller.signal)
    await vi.waitFor(() => expect(ownership).toHaveBeenCalledOnce())
    if (change === 'model') {
      models.set(route.ptyId, { ...model })
    } else if (change === 'write') {
      model.writeChain = Promise.resolve()
    } else if (change === 'output') {
      vi.spyOn(runtime, 'getPtyOutputSequence').mockReturnValue(999)
    } else {
      controller.abort(new Error('aborted'))
    }
    const refused = expect(settling).rejects.toThrow(
      change === 'abort' ? 'aborted' : 'model_changed'
    )
    pending.resolve()
    await refused
  }
)

it('keeps the returned assertion bound to the settled model after completion', async () => {
  const { runtime } = await setup()
  const result = await runtime.settleOutgoingSshPtyCatalogModels(
    'target',
    new AbortController().signal
  )
  const models = trackedModels(runtime)
  models.set(route.ptyId, { ...models.get(route.ptyId)! })
  expect(result.assertCurrent).toThrow('model_changed')
})

it.each(['write', 'ownership'] as const)(
  'aborts the %s wait without waiting for the model work to finish',
  async (phase) => {
    const { runtime } = await setup()
    const model = trackedModels(runtime).get(route.ptyId)!
    const pending = Promise.withResolvers<void>()
    if (phase === 'write') {
      model.writeChain = pending.promise
    } else {
      vi.spyOn(model.ownership, 'settle').mockReturnValue(pending.promise)
    }
    const controller = new AbortController()
    const settling = runtime.settleOutgoingSshPtyCatalogModels('target', controller.signal)
    await Promise.resolve()
    controller.abort(new Error('stop waiting'))
    await expect(settling).rejects.toThrow('stop waiting')
    expect(trackedModels(runtime).get(route.ptyId)).toBe(model)
    pending.resolve()
  }
)

it('binds outgoing folder placement to the tracked SSH pane', async () => {
  const { runtime } = await setup()
  const assertCurrent = runtime.bindOutgoingSshPtySurface(route.ptyId, surface)
  expect(() => assertCurrent()).not.toThrow()
})

it('refuses stale registration without replacing a fenced source model or reporting exit', async () => {
  const { runtime } = await setup()
  const before = runtime.bindOutgoingSshPtyCatalogSurfaces('target')
  const model = trackedModels(runtime).get(route.ptyId)!
  const exit = vi.spyOn(runtime, 'onPtyExit')
  fenceOutgoingPtyRegistrations(runtime, [route.ptyId])
  fenceOutgoingPtyRegistrations(runtime, [route.ptyId])
  for (const incarnationId of [undefined, identity.incarnationId, 'replacement']) {
    expect(() => runtime.assertPtyRegistrationAllowed(route.ptyId, incarnationId)).toThrow(
      'source_registration_fenced'
    )
    expect(() =>
      runtime.registerPty(route.ptyId, 'folder:folder-1', 'target', {
        tabId: surface.tabId,
        leafId: surface.leafId,
        incarnationId
      })
    ).toThrow('source_registration_fenced')
  }
  before.assertCurrent()
  expect(trackedModels(runtime).get(route.ptyId)).toBe(model)
  expect(exit).not.toHaveBeenCalled()
  const other = await setup()
  expect(() => other.runtime.registerPty(route.ptyId, 'folder:folder-1', 'target')).not.toThrow()
  expect(() =>
    runtime.registerPty(
      toAppSshPtyId('other-host', identity.terminalId),
      'folder:folder-2',
      'other-host'
    )
  ).not.toThrow()
})

it('binds source handle aliases during actual runtime model settlement', async () => {
  const { runtime } = await setup()
  const model = trackedModels(runtime).get(route.ptyId)!
  const pending = Promise.withResolvers<void>()
  const ownership = vi.spyOn(model.ownership, 'settle').mockReturnValue(pending.promise)
  const settling = runtime.settleOutgoingSshPtyCatalogModels('target', new AbortController().signal)
  await vi.waitFor(() => expect(ownership).toHaveBeenCalledOnce())
  const aliases = (runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId
  aliases.set(route.ptyId, 'term-replacement')
  const refused = expect(settling).rejects.toThrow('source_graph_changed')
  pending.resolve()
  await refused
  expect(aliases.get(route.ptyId)).toBe('term-replacement')
})

it('refuses late output and context resets before changing a fenced source model', async () => {
  const { runtime } = await setup()
  const model = trackedModels(runtime).get(route.ptyId)!
  const sequence = runtime.getPtyOutputSequence(route.ptyId)
  const writeChain = model.writeChain
  const exit = vi.spyOn(runtime, 'onPtyExit')
  const dispose = vi.spyOn(model.emulator, 'dispose')
  const receipt = vi.fn()
  fenceOutgoingPtyRegistrations(runtime, [route.ptyId])
  for (const mutate of [
    () => runtime.acceptPtyDataBounded(route.ptyId, 'late output', Date.now()),
    () => runtime.onPtyData(route.ptyId, 'late output', Date.now(), 11, false, receipt),
    () => runtime.preparePtyExecutionContext(route.ptyId, null, { resetIncarnation: true }),
    () => runtime.preparePtyExecutionContext(route.ptyId, 'replacement-distro'),
    () => runtime.resetPtyModelAfterMigrationFailure(route.ptyId)
  ]) {
    expect(mutate).toThrow('source_model_mutation_fenced')
  }
  expect(runtime.getPtyOutputSequence(route.ptyId)).toBe(sequence)
  expect(trackedModels(runtime).get(route.ptyId)).toBe(model)
  expect(model.writeChain).toBe(writeChain)
  expect(receipt).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
  expect(exit).not.toHaveBeenCalled()
  const other = await setup()
  await expect(
    other.runtime.acceptPtyDataBounded(route.ptyId, 'still accepted', Date.now()).completion
  ).resolves.toBeUndefined()
})

it('does not project or credit source output refused by the runtime cleanup fence', async () => {
  const { runtime } = await setup()
  const sequence = runtime.getPtyOutputSequence(route.ptyId)
  fenceOutgoingPtyRegistrations(runtime, [route.ptyId])
  const project = vi.fn()
  const publishSourceAck = vi.fn()
  const { intake, dependencies } = createSshPtyOutputIntakeHarness({
    getModelSequence: () => runtime.getPtyOutputSequence(route.ptyId),
    acceptModel: (event) => runtime.acceptPtyDataBounded(event.id, event.data, Date.now()),
    project,
    publishSourceAck
  })
  vi.useFakeTimers()
  try {
    await expect(
      intake.acceptData(
        sshPtyOutputEvent({
          id: route.ptyId,
          ptyIncarnation: identity.incarnationId,
          source: {
            relayPtyId: identity.terminalId,
            spanId: 'late:0:4',
            clientGeneration: 2,
            ownerGeneration: 3,
            deliveryToken: 'late',
            sourceStartSu: 0,
            sourceEndSu: 4
          }
        })
      )
    ).rejects.toThrow('source_model_mutation_fenced')
    await vi.advanceTimersByTimeAsync(20)
    expect(project).not.toHaveBeenCalled()
    expect(publishSourceAck).not.toHaveBeenCalled()
    expect(runtime.getPtyOutputSequence(route.ptyId)).toBe(sequence)
    expect(intake.getAcceptedSourceCheckpoints(1)).toEqual([
      expect.objectContaining({ id: route.ptyId, acceptedSourceEndSu: 0 })
    ])
    expect(dependencies.closeProvider).toHaveBeenCalledWith(1, 'model-admission-failed')
  } finally {
    vi.useRealTimers()
  }
})
it('captures exact folder and worktree source surfaces while isolating another host', async () => {
  const { runtime } = await setup()
  const secondId = toAppSshPtyId('target', 'second')
  runtime.registerPty(secondId, 'repo::/host/worktree', 'target', {
    tabId: 'tab-2',
    leafId: '22222222-2222-4222-8222-222222222222',
    incarnationId: 'second-incarnation'
  })
  const inventory = runtime.bindOutgoingSshPtyCatalogSurfaces('target')
  expect(inventory.surfaces).toEqual([
    { ptyId: route.ptyId, incarnationId: identity.incarnationId, surfaceBinding: surface },
    {
      ptyId: secondId,
      incarnationId: 'second-incarnation',
      surfaceBinding: {
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::/host/worktree',
        tabId: 'tab-2',
        leafId: '22222222-2222-4222-8222-222222222222',
        ptyId: 'second'
      }
    }
  ])
  runtime.registerPty(toAppSshPtyId('other', 'other'), 'folder:other', 'other')
  expect(() => inventory.assertCurrent()).not.toThrow()
  Object.assign(inventory.surfaces[0].surfaceBinding, { tabId: 'caller-mutated' })
  expect(() => inventory.assertCurrent()).not.toThrow()
  expect(runtime.bindOutgoingSshPtyCatalogSurfaces('target').surfaces[0].surfaceBinding).toEqual(
    surface
  )
})

it.each(['added', 'removed', 'replaced', 'disconnected', 'incarnation', 'pane', 'host'])(
  'refuses catalog source inventory after a terminal is %s',
  async (change) => {
    const { runtime } = await setup()
    const inventory = runtime.bindOutgoingSshPtyCatalogSurfaces('target')
    const internal = runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }
    const tracked = internal.ptysById.get(route.ptyId)!
    if (change === 'added') {
      runtime.registerPty(toAppSshPtyId('target', 'added'), 'folder:folder-1', 'target')
    } else if (change === 'removed') {
      internal.ptysById.delete(route.ptyId)
    } else if (change === 'replaced') {
      internal.ptysById.set(route.ptyId, { ...tracked })
    } else {
      const fields = {
        disconnected: 'connected',
        incarnation: 'incarnationId',
        pane: 'paneKey',
        host: 'connectionId'
      }
      tracked[fields[change as keyof typeof fields]] = change === 'disconnected' ? false : 'changed'
    }
    expect(() => inventory.assertCurrent()).toThrow()
  }
)

it('refuses incomplete or duplicate source pane authority without omitting terminals', async () => {
  const { runtime } = await setup()
  const id = toAppSshPtyId('target', 'second')
  runtime.registerPty(id, 'folder:folder-1', 'target')
  expect(() => runtime.bindOutgoingSshPtyCatalogSurfaces('target')).toThrow()
  const internal = runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }
  Object.assign(internal.ptysById.get(id)!, {
    tabId: surface.tabId,
    paneKey: `${surface.tabId}:${surface.leafId}`,
    incarnationId: 'second-incarnation'
  })
  expect(() => runtime.bindOutgoingSshPtyCatalogSurfaces('target')).toThrow('duplicate_pane')
})

it('refuses conflicting source host bookkeeping instead of omitting its routed terminal', async () => {
  const { runtime } = await setup()
  const internal = runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }
  internal.ptysById.get(route.ptyId)!.connectionId = 'other'
  expect(() => runtime.bindOutgoingSshPtyCatalogSurfaces('target')).toThrow('surface_changed')
})
it.each(['workspaceKey', 'tabId', 'leafId', 'ptyId'])(
  'rejects an unrelated outgoing %s before preparation',
  async (field) => {
    const { runtime } = await setup()
    const value =
      field === 'workspaceKey'
        ? 'folder:other'
        : field === 'leafId'
          ? '22222222-2222-4222-8222-222222222222'
          : 'other'
    expect(() =>
      runtime.bindOutgoingSshPtySurface(route.ptyId, { ...surface, [field]: value })
    ).toThrow()
  }
)
it.each(['incarnationId', 'worktreeId', 'connectionId', 'connected'])(
  'fences outgoing preparation when tracked %s changes',
  async (field) => {
    const { runtime } = await setup()
    const assertCurrent = runtime.bindOutgoingSshPtySurface(route.ptyId, surface)
    const internal = runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }
    internal.ptysById.get(route.ptyId)![field] = field === 'connected' ? false : 'changed'
    expect(() => assertCurrent()).toThrow('source_surface_changed')
  }
)
it('derives worktree placement without treating it as a folder workspace', async () => {
  const { runtime } = await setup()
  const internal = runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }
  internal.ptysById.get(route.ptyId)!.worktreeId = 'repo::/host/worktree'
  expect(() =>
    runtime.bindOutgoingSshPtySurface(route.ptyId, {
      ...surface,
      workspaceKey: 'worktree:repo::/host/worktree'
    })()
  ).not.toThrow()
})

it('serializes the actual desktop model with exact source binding and a separate pending escape tail', async () => {
  const { runtime, data } = await setup()
  const result = await runtime.serializeSshPtyOwnershipCapture(boundary, route)
  expect(result).toMatchObject({
    identity,
    throughSeq: 20,
    modelSequenceEnd: data.length,
    restoreMetadata: { version: 1, pendingEscapeTailAnsi: '\x1b[3' }
  })
  expect(result.modelData).toContain('retained output')
  expect(result.modelData.endsWith('\x1b[3')).toBe(false)
  expect(getSshPtyAcceptedSourceCheckpoints).toHaveBeenCalledTimes(2)
})

it('refuses a checkpoint that changes while serialization awaits the model', async () => {
  const { runtime } = await setup()
  vi.mocked(getSshPtyAcceptedSourceCheckpoints)
    .mockReturnValueOnce([checkpoint])
    .mockReturnValueOnce([{ ...checkpoint, acceptedSourceEndSu: 101 }])
  await expect(runtime.serializeSshPtyOwnershipCapture(boundary, route)).rejects.toThrow(
    'checkpoint_unavailable'
  )
})

it('rejects extra model output during capture rather than assigning it the older host boundary', async () => {
  const { runtime } = await setup()
  const pending = runtime.serializeSshPtyOwnershipCapture(boundary, route)
  await runtime.acceptPtyDataBounded(route.ptyId, 'new', Date.now()).completion
  await expect(pending).rejects.toThrow('route_changed')
})

it('refuses replaced incarnations and cancelled capture', async () => {
  const { runtime } = await setup()
  const controller = new AbortController()
  controller.abort()
  await expect(
    runtime.serializeSshPtyOwnershipCapture(boundary, route, controller.signal)
  ).rejects.toThrow()
  runtime.registerPty(route.ptyId, 'folder:folder-1', 'target', {
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    incarnationId: 'replacement'
  })
  await expect(runtime.serializeSshPtyOwnershipCapture(boundary, route)).rejects.toThrow(
    'route_changed'
  )
})

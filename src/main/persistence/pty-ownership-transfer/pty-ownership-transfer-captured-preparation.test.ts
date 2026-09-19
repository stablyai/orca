import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../../persistence-test-harness'
import { connectOrcadLocalRelay } from '../../orcad/orcad-local-relay-connection'
import {
  context,
  identity,
  preparation,
  request
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { capturedPreparationFixture as setup } from './pty-ownership-transfer-captured-preparation-test-fixture'
import * as durable from '../../durable-file-write'
import { readCapturedPtyPublicationRetry } from './pty-ownership-transfer-captured-publication-retry'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../orcad/orcad-local-relay-connection', () => ({ connectOrcadLocalRelay: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-captured-preparation-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(connectOrcadLocalRelay).mockReset()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('rejects an in-flight source probe after destination admission closes, without creating destination state', async () => {
  const f = setup()
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  f.rpc.mockImplementationOnce(async (_method, params) => {
    await gate
    return f.source.inspectDestination(params, context())
  })
  const pending = f.registry.prepareCapturedDelegated(f.input)
  const rejected = expect(pending).rejects.toThrow('admission_closed')
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce())
  f.registry.fenceAdmissionForDecommission()
  resume()
  await rejected
  expect(f.registry.listRecoveryCandidates()).toEqual([])
  expect(f.destinationStore.load(identity)).toBeNull()
  expect(f.source.inspectDestination(request(), context())).toMatchObject({
    phase: 'prepared',
    destinationClaim: null,
    destinationAcknowledgedSeq: 0
  })
})

it('refuses decommission once capture has a durable destination and allows that transfer to finish', async () => {
  const f = setup()
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let calls = 0
  f.rpc.mockImplementation(async (_method, params) => {
    if (++calls === 2) {
      await gate
    }
    return f.source.inspectDestination(params, context())
  })
  const pending = f.registry.prepareCapturedDelegated(f.input)
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2))
  expect(f.registry.listRecoveryCandidates()).toHaveLength(1)
  expect(() => f.registry.fenceAdmissionForDecommission()).toThrow(
    'decommission_destination_unverifiable'
  )
  resume()
  await expect(pending).resolves.toMatchObject({ snapshot: { phase: 'published' } })
})

it('publishes only the captured model at B while retaining source output through E, including retries after restart', async () => {
  const f = setup()
  const result = await f.registry.prepareCapturedDelegated(f.input)
  expect(result.snapshot).toMatchObject({ phase: 'published', acceptedSourceEndSeq: 1 })
  expect(result.importReceipt).toMatchObject({
    throughSeq: 1,
    modelSha256: f.selection.modelSha256
  })
  expect(result.outputOutbox.loadInitialModelSnapshot(identity)).toEqual(f.model)
  expect(f.source.inspectDestination(request(), context())).toMatchObject({
    phase: 'prepared',
    sourceOutputEndSeq: 2,
    destinationAcknowledgedSeq: 0,
    destinationClaim: null
  })
  expect(f.sourceStore.loadAll()[0].history.frames).toEqual([
    { seq: 1, data: 'one🙂' },
    { seq: 2, data: 'later' }
  ])
  const recoveredStore = createStore()
  const binding = preparation.surfacePublication.surfaceBinding
  const ref =
    recoveredStore.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
      ?.scrollbackRefsByLeafId?.[binding.leafId]
  expect(ref && recoveredStore.readTerminalScrollbackSnapshot(ref)).toBe(
    f.model.modelData + f.model.restoreMetadata.pendingEscapeTailAnsi
  )
  const retry = await f.reopen().prepareCapturedDelegated(f.input)
  expect(retry.publicationReceipt).toEqual(result.publicationReceipt)
  expect(retry.snapshot.commitReceipt).toEqual(result.snapshot.commitReceipt)
})

it('reads exact publication evidence after registry reopen without contacting or resetting a claimed source', async () => {
  const f = setup()
  const prepared = await f.registry.prepareCapturedDelegated(f.input)
  f.source.claimDestination(request(), context())
  const before = f.source.inspectDestination(request(), context())
  const reopened = f.reopen()
  reopened.recoverPersistedDelegatedDestinations()
  const destination = reopened.getPublishedDelegatedDestination(identity)
  const journal = destination.store.load(identity)
  const output = destination.outbox.load(identity)
  f.rpc.mockClear()
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  const retry = readCapturedPtyPublicationRetry(f.input, destination)
  expect(retry.publicationReceipt).toEqual(prepared.publicationReceipt)
  expect(retry.importReceipt).toEqual(prepared.importReceipt)
  expect(destination.store.load(identity)).toEqual(journal)
  expect(destination.outbox.load(identity)).toEqual(output)
  expect(f.source.inspectDestination(request(), context())).toEqual(before)
  expect(f.rpc).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it.each([
  'endpoint',
  'credential',
  'missing-journal',
  'missing-model',
  'missing-receipt',
  'changed-receipt'
] as const)(
  'refuses captured-publication retry with %s evidence without mutation',
  async (failure) => {
    const f = setup()
    await f.registry.prepareCapturedDelegated(f.input)
    const destination = f.registry.getPublishedDelegatedDestination(identity)
    const original = destination.store.load(identity)!
    const input = { ...f.input }
    if (failure === 'endpoint' || failure === 'credential') {
      input.source = {
        ...input.source!,
        ...(failure === 'endpoint'
          ? { endpoint: '/different-source' }
          : { endpointCredential: 'different-credential' })
      }
    }
    if (failure === 'missing-journal') {
      vi.spyOn(destination.store, 'load').mockReturnValue(null)
    }
    if (failure === 'missing-model') {
      vi.spyOn(destination.outbox, 'loadInitialModelSnapshot').mockReturnValue(null)
    }
    if (failure === 'missing-receipt' || failure === 'changed-receipt') {
      vi.spyOn(destination.store, 'load').mockReturnValue({
        ...original,
        receipt:
          failure === 'missing-receipt'
            ? undefined
            : { ...original.receipt!, receiptId: 'conflicting-receipt' }
      })
    }
    f.rpc.mockClear()
    const write = vi.spyOn(durable, 'writeFileDurableSync')
    expect(() => readCapturedPtyPublicationRetry(input, destination)).toThrow('retry_unverifiable')
    expect(write).not.toHaveBeenCalled()
    expect(f.rpc).not.toHaveBeenCalled()
  }
)

it.each(['digest', 'capability', 'surface', 'claim', 'credential', 'runtime'])(
  'rejects invalid %s before destination writes',
  async (mode) => {
    const f = setup()
    if (mode === 'digest') {
      f.input.model = { ...f.model, modelData: 'wrong' }
    }
    if (mode === 'runtime') {
      f.input.identity = { ...identity, destinationRuntimeId: 'wrong' }
    }
    if (mode === 'credential') {
      f.rpc.mockRejectedValue(new Error('unauthorized'))
    }
    if (mode === 'claim') {
      f.source.claimDestination(request(), context())
    }
    if (mode === 'surface' || mode === 'capability') {
      f.rpc.mockImplementation(async () => ({
        ...f.source.inspectDestination(request(), context()),
        ...(mode === 'surface'
          ? { surfacePublication: undefined }
          : { captureImportAckVersion: undefined })
      }))
    }
    const write = vi.spyOn(durable, 'writeFileDurableSync')
    await expect(f.registry.prepareCapturedDelegated(f.input)).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(f.destinationStore.load(identity)).toBeNull()
  }
)

it.each([2, 3])('refuses publication if source is claimed at status check %s', async (at) => {
  const f = setup()
  let calls = 0
  f.rpc.mockImplementation(async (_method, params) => {
    if (++calls === at) {
      f.source.claimDestination(request(), context())
    }
    return f.source.inspectDestination(params, context())
  })
  await expect(f.registry.prepareCapturedDelegated(f.input)).rejects.toThrow('no_longer_preparable')
  expect(f.destinationStore.load(identity)?.phase).toBe('prepared')
  expect(createStore().getWorkspaceSession().tabsByWorktree['folder:folder-1']).toBeUndefined()
  expect(f.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
})

it('refuses a fresh preparation after durable destination claim intent', async () => {
  const f = setup()
  await f.registry.prepareCapturedDelegated(f.input)
  f.destinationStore.reserveDelegatedClaimIntent(identity, null, {
    version: 1,
    previousClaim: null,
    claim: { generation: 1, claimId: 'claim-1' }
  })
  f.rpc.mockClear()
  await expect(f.reopen().prepareCapturedDelegated(f.input)).rejects.toThrow('already_claimed')
  expect(f.rpc).not.toHaveBeenCalled()
})

it('looks up only an exact published delegated destination without resetting or writing it', async () => {
  const f = setup()
  expect(() => f.registry.getPublishedDelegatedDestination(identity)).toThrow('adapter_unavailable')
  const prepared = f.registry.prepareDelegated(
    {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 2,
      surfacePublication: preparation.surfacePublication
    },
    f.input.source
  )
  expect(() => f.registry.getPublishedDelegatedDestination(identity)).toThrow(
    'publication_unavailable'
  )
  await f.registry.prepareCapturedDelegated(f.input)
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  const prepare = vi.spyOn(prepared.adapter, 'prepare')
  const found = f.registry.getPublishedDelegatedDestination(identity)
  expect(found.adapter).toBe(prepared.adapter)
  expect(found.outbox).toBe(prepared.outputOutbox)
  expect(found.identity).toEqual(identity)
  expect(() =>
    f.registry.getPublishedDelegatedDestination({ ...identity, incarnationId: 'other' })
  ).toThrow('identity_mismatch')
  expect(write).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})

it.each([
  ['committed', 'before'],
  ['committed', 'after'],
  ['published', 'before'],
  ['published', 'after']
])('recovers an uncertain %s journal write %s persistence', async (phase, timing) => {
  const f = setup()
  const write = durable.writeFileDurableSync
  let injected = false
  const fault = vi.spyOn(durable, 'writeFileDurableSync').mockImplementation((...args) => {
    let record: { journal?: { side?: string; phase?: string } } | undefined
    try {
      record = JSON.parse(String(args[2]))
    } catch {
      /* Non-journal payload. */
    }
    if (!injected && record?.journal?.side === 'destination' && record.journal.phase === phase) {
      injected = true
      if (timing === 'after') {
        write(...args)
      }
      throw new Error('uncertain journal write')
    }
    return write(...args)
  })
  await expect(f.registry.prepareCapturedDelegated(f.input)).rejects.toThrow(
    'uncertain journal write'
  )
  expect(injected).toBe(true)
  fault.mockRestore()
  const persistedReceipt = f.destinationStore.load(identity)?.receipt
  const recovered = await f.reopen().prepareCapturedDelegated(f.input)
  expect(recovered.snapshot.phase).toBe('published')
  if (persistedReceipt) {
    expect(recovered.snapshot.commitReceipt).toEqual(persistedReceipt)
  }
  expect(recovered.outputOutbox.loadInitialModelSnapshot(identity)).toEqual(f.model)
  expect(f.source.inspectDestination(request(), context())).toMatchObject({
    phase: 'prepared',
    destinationAcknowledgedSeq: 0,
    destinationClaim: null
  })
  expect(f.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
})

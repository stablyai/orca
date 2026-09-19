import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { PTY_CAPTURED_DESTINATION_PREPARE_METHOD } from '../../shared/pty-ownership-transfer-runtime-methods'
import { createOrcadModelImportSocketFixture } from './orcad-model-import-socket-fixture'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { createOrcadDelegatedProviderBinding } from './orcad-delegated-pty-provider'
import { getProviderForPty, getLocalPtyProvider } from '../ipc/pty/provider/registry'
import * as providerRegistry from '../ipc/pty/provider/registry'
import { listProcessesWithHostScopeFromRuntimeController } from '../ipc/pty/runtime/inventory-operations'
import {
  PtyOwnershipTransferDestinationFileStore,
  ptyOwnershipTransferDestinationDirectory
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import {
  identity,
  source as sourceIdentity,
  preparation,
  request,
  context
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import * as durable from '../durable-file-write'
import { readCapturedPtyPublicationRetry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-captured-publication-retry'
import { recoverOutgoingOrcadCapture } from '../ssh/orcad-outgoing-capture-recovery'
import { OrcadOutgoingCaptureStore } from '../ssh/orcad-outgoing-capture-store'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../shared/runtime-environment-store'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { getSshTargetRegistryStore, setSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let close: (() => Promise<void>) | undefined
const connections: Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>[] = []
const lifetimes: OrcadRuntimeLifetime[] = []
const servers: OrcaRuntimeRpcServer[] = []
let restoreTargetStore: (() => void) | undefined
beforeEach(() => {
  const terminalId = `pty-${randomUUID()}`
  identity.terminalId = terminalId
  sourceIdentity.terminalId = terminalId
  preparation.terminalId = terminalId
  preparation.surfacePublication.surfaceBinding.ptyId = terminalId
  const registered = providerRegistry.registeredPtyProviders
  // Each fixture simulates a fresh host process; prior fixtures' reservations are not its inventory.
  vi.spyOn(providerRegistry, 'registeredPtyProviders').mockImplementation(() =>
    registered().filter(
      (entry) => !entry.delegatedIdentity || entry.delegatedIdentity.terminalId === terminalId
    )
  )
  testState.dir = mkdtempSync(join(tmpdir(), 'oc-cap-'))
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop()
  }
  for (const lifetime of lifetimes.splice(0)) {
    await lifetime.stop()
  }
  for (const connection of connections.splice(0)) {
    await connection.dispose()
  }
  await close?.()
  close = undefined
  restoreTargetStore?.()
  restoreTargetStore = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

const binding = preparation.surfacePublication.surfaceBinding
const suffix = 'm after capture\r\n'
const sourceOptions = {
  enableDestinationOutputRoutes: true,
  enableDestinationDelegationCommit: true,
  resolveTerminalIncarnation: () => identity.incarnationId,
  hasPendingSourceOutput: () => false,
  inspectDestinationTerminal: () => ({ pid: 42, cols: 80, rows: 24, initialCwd: '/initial' }),
  inspectDestinationCwd: async () => '/host/current'
}
function runtimeFor(mutationEnabled = false) {
  const store = createStore()
  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId: identity.destinationRuntimeId,
    ptyOwnershipTransferMutationEnabled: () => mutationEnabled
  })
  runtime.installPtyOwnershipTransferDestinationOutputBridge()
  const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
  const destinationStore = new PtyOwnershipTransferDestinationFileStore({
    directory: ptyOwnershipTransferDestinationDirectory(store.getProfileStorageDirectory())
  })
  return { store, runtime, registry, destinationStore }
}

it.each([false, true])(
  'catches up the real model and commits B after durable E, with failed-write recovery=%s',
  async (failWrite) => {
    const source = await createOrcadModelImportSocketFixture(testState.dir, {
      laterOutput: suffix,
      sourceOptions
    })
    close = source.close
    const first = runtimeFor()
    const prepared = await first.registry.prepareCapturedDelegated({
      identity,
      source: source.store.loadDelegatedSource(identity),
      model: source.model,
      signal: source.controller.signal
    })
    const receipt = prepared.snapshot.commitReceipt!
    const onError = vi.fn()
    const connect = async (
      host: ReturnType<typeof runtimeFor>,
      adapter: typeof prepared.adapter,
      outbox: typeof prepared.outputOutbox
    ) => {
      host.runtime.registerPublishedDelegatedPty(identity)
      const connection = await connectOrcadDelegatedTransfer({
        identity,
        store: host.destinationStore,
        adapter,
        outbox,
        signal: source.controller.signal,
        onError,
        onExit: (event) => host.runtime.acceptDelegatedPtyExit(event),
        onExecutionState: (identity, claim) =>
          host.runtime.acceptDelegatedPtyExecutionState(identity, claim),
        providerModel: {
          snapshot: (options) =>
            host.runtime.serializePublishedDelegatedPtyModel(identity, options),
          sequence: () => host.runtime.getPtyOutputSequence(identity.terminalId)
        },
        initializeModel: (signal) =>
          host.runtime.initializeDelegatedPtyOwnershipModel(identity, signal),
        prepareModelFrame: (frame) => host.runtime.prepareDelegatedPtyModelFrame(identity, frame)
      })
      connections.push(connection)
      return connection
    }
    const write = durable.writeFileDurableSync
    let failed = false
    const fault = vi.spyOn(durable, 'writeFileDurableSync').mockImplementation((...args) => {
      if (
        failWrite &&
        !failed &&
        args[1].includes('output-outbox-v1') &&
        String(args[2]).includes(suffix.replace(/\r/g, '\\r').replace(/\n/g, '\\n'))
      ) {
        failed = true
        throw new Error('durable suffix unavailable')
      }
      return write(...args)
    })
    let active = await connect(first, prepared.adapter, prepared.outputOutbox)
    if (failWrite) {
      await expect.poll(() => onError.mock.calls.length).toBe(1)
      expect(onError.mock.calls[0][0]).toMatchObject({ message: 'durable suffix unavailable' })
      expect(source.source.inspectDestination(request(), context())).toMatchObject({
        phase: 'prepared',
        destinationAcknowledgedSeq: 1,
        sourceOutputEndSeq: 2
      })
      expect(source.sourceStore.loadAll()[0].history.frames).toEqual([{ seq: 2, data: suffix }])
      expect(prepared.outputOutbox.load(identity)?.acceptedEndSeq).toBe(1)
      await active.dispose()
      fault.mockRestore()
      onError.mockClear()
      const retry = runtimeFor()
      const recovered = retry.registry.recoverPersistedDelegatedDestinations()[0]
      active = await connect(retry, recovered.adapter, recovered.outbox)
    } else {
      fault.mockRestore()
    }
    await expect.poll(() => active.isCommitReconciled()).toBe(true)
    expect(source.source.inspectDestination(request(), context())).toMatchObject({
      phase: 'committed',
      destinationAcknowledgedSeq: 2,
      sourceOutputEndSeq: 2,
      receipt
    })
    await expect.poll(() => prepared.outputOutbox.load(identity)?.acknowledgedEndSeq).toBe(2)
    expect(prepared.outputOutbox.loadModelSnapshot(identity)?.checkpoint.modelSequenceEnd).toBe(
      100 + suffix.length
    )
    expect(source.sourceStore.loadAll()[0].history.frames).toEqual([{ seq: 2, data: suffix }])
    expect(onError).not.toHaveBeenCalled()
    await active.dispose()
    await source.reopenSource()
    expect(source.source.inspectDestination(request(), context())).toMatchObject({
      phase: 'committed',
      destinationAcknowledgedSeq: 1,
      receipt
    })

    const restarted = runtimeFor()
    const recovered = restarted.registry.recoverPersistedDelegatedDestinations()[0]
    const reconnected = await connect(restarted, recovered.adapter, recovered.outbox)
    await expect.poll(() => reconnected.isCommitReconciled()).toBe(true)
    await expect
      .poll(() => restarted.runtime.getPtyLivenessVerdict(identity.terminalId)?.status)
      .toBe('live')
    await expect(
      reconnected.providerInspection.listProcesses({ deadlineMs: Date.now() + 2000 })
    ).resolves.toEqual([
      {
        id: identity.terminalId,
        incarnationId: identity.incarnationId,
        rootProcessId: 42,
        cwd: '/host/current',
        title: '',
        worktreeId: binding.workspaceKey
      }
    ])
    const model = await restarted.runtime.serializePublishedDelegatedPtyModel(identity)
    expect(model?.seq).toBe(100 + suffix.length)
    expect(model?.data.match(/one🙂/g)).toHaveLength(1)
    expect(model?.data.match(/after capture/g)).toHaveLength(1)
    const sourceBeforeAttach = source.source.inspectDestination(request(), context())
    await expect(reconnected.providerAttachment!.attach(identity.terminalId)).resolves.toEqual({
      providerSequence: { value: model!.seq, generation: 'continued' }
    })
    await expect(
      reconnected.providerAttachment!.getBufferSnapshot(identity.terminalId)
    ).resolves.toMatchObject({
      seq: model!.seq,
      data: model!.data
    })
    expect(source.source.inspectDestination(request(), context())).toEqual(sourceBeforeAttach)
    expect(recovered.adapter.snapshot().commitReceipt).toEqual(receipt)
    source.source.observeOutput(identity.terminalId, 'new output\r\n')
    await expect.poll(() => recovered.outbox.load(identity)?.acknowledgedEndSeq).toBe(3)
    const latest = await restarted.runtime.serializePublishedDelegatedPtyModel(identity)
    expect(latest?.data.match(/after capture/g)).toHaveLength(1)
    expect(latest?.data.match(/new output/g)).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    vi.spyOn(reconnected.client, 'status').mockRejectedValueOnce(new Error('status unavailable'))
    await expect(reconnected.refreshExecution()).rejects.toThrow('status unavailable')
    expect(reconnected.isActive()).toBe(false)
    expect(restarted.runtime.getPtyLivenessVerdict(identity.terminalId)?.status).toBe(
      'unverifiable'
    )
    const finalHost = runtimeFor()
    const finalRecovery = finalHost.registry.recoverPersistedDelegatedDestinations()[0]
    const exited = await connect(finalHost, finalRecovery.adapter, finalRecovery.outbox)
    const acceptedExit = vi.spyOn(finalHost.runtime, 'acceptDelegatedPtyExit')
    const providerExit = vi.fn(() => expect(acceptedExit).toHaveBeenCalledTimes(1))
    exited.onExit(providerExit)
    source.source.observeExit(identity.terminalId, identity.incarnationId, 17)
    await expect.poll(() => providerExit.mock.calls.length).toBe(1)
    expect(providerExit).toHaveBeenCalledWith({
      id: identity.terminalId,
      incarnationId: identity.incarnationId,
      code: 17
    })
    const staleExit = vi.fn()
    reconnected.onExit(staleExit)
    expect(staleExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  }
)

it.each([false, true, 'interrupted'] as const)(
  'joins a newly published terminal and closes its lifecycle (retired=%s)',
  async (retired) => {
    const source = await createOrcadModelImportSocketFixture(testState.dir, {
      laterOutput: suffix,
      sourceOptions
    })
    close = source.close
    const host = runtimeFor(true)
    const release = vi.fn()
    const lifetime = new OrcadRuntimeLifetime(release)
    lifetimes.push(lifetime)
    const onError = vi.fn()
    const removeBinding = vi.fn()
    const bindConnection = vi.fn((identity, connection) => {
      const bind = createOrcadDelegatedProviderBinding(host.runtime, () => ({
        getDefaultShell: async () => '/host/shell',
        getProfiles: async () => []
      }))
      const unbind = bind(identity, connection)
      return () => {
        unbind()
        removeBinding()
      }
    })
    const initializeModel = vi.fn(async (identity, signal) => {
      host.runtime.registerPublishedDelegatedPty(identity)
      await host.runtime.initializeDelegatedPtyOwnershipModel(identity, signal)
    })
    const lifecycle = installOrcadDelegatedRecovery({
      enabled: true,
      onExit: (event) => host.runtime.acceptDelegatedPtyExit(event),
      recoverRetirement: host.runtime.recoverDelegatedPtyRetirement,
      onExecutionState: (identity, claim) =>
        host.runtime.acceptDelegatedPtyExecutionState(identity, claim),
      bindConnection,
      registry: host.registry,
      lifetime,
      onError,
      initializeModel,
      providerModel: {
        snapshot: (identity, options) =>
          host.runtime.serializePublishedDelegatedPtyModel(identity, options),
        sequence: (identity) => host.runtime.getPtyOutputSequence(identity.terminalId)
      },
      prepareModelFrame: (identity, frame, signal) =>
        host.runtime.prepareDelegatedPtyModelFrame(identity, frame, signal)
    })!
    expect(source.accepted).not.toHaveBeenCalled()
    lifetime.add(host.runtime.installCapturedPtyDestinationLifecycle(lifecycle))
    mkdirSync(join(testState.dir, 'rpc'))
    const server = new OrcaRuntimeRpcServer({
      runtime: host.runtime,
      userDataPath: join(testState.dir, 'rpc'),
      enableWebSocket: true,
      pinnedBindHost: '127.0.0.1',
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'capture-client',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('Runtime pairing unavailable')
    }
    const pairing = parsePairingCode(offer.pairingUrl)!
    const retryRequest = {
      identity,
      source: source.store.loadDelegatedSource(identity),
      model: source.model,
      signal: source.controller.signal
    }
    const outgoing = new OrcadOutgoingCaptureStore(join(testState.dir, 'desktop'))
    const savedCapture = outgoing.persist({
      version: 1,
      ...retryRequest,
      selection: source.selection,
      surfaceBinding: binding,
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1
    })
    const desktop = join(testState.dir, 'desktop')
    addEnvironmentFromPairingCode(desktop, {
      id: 'destination',
      name: 'Destination',
      pairingCode: offer.pairingUrl
    })
    markEnvironmentUsed(desktop, 'destination', { runtimeId: identity.destinationRuntimeId })
    host.store.addSshTarget({
      id: 'source',
      label: 'Source',
      host: 'host',
      port: 22,
      username: 'user',
      generation: 1
    })
    const previousTargetStore = getSshTargetRegistryStore()
    setSshTargetRegistryStore(new SshConnectionStore(host.store))
    restoreTargetStore = () => setSshTargetRegistryStore(previousTargetStore)
    vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
    expect(host.registry.get(identity.bridgeId)).toBeNull()
    if (retired === true) {
      const status = source.source.inspectDestination(request(), context())
      const inspect = vi.spyOn(source.source, 'inspectDestination')
      inspect.mockReturnValueOnce({ ...status, captureBaseline: undefined })
      await expect(
        recoverOutgoingOrcadCapture(desktop, { identity, signal: source.controller.signal })
      ).rejects.toThrow('orcad_captured_destination_failed:')
      expect(inspect).toHaveBeenCalledOnce()
      inspect.mockRestore()
      expect(host.registry.get(identity.bridgeId)).toBeNull()
      expect(outgoing.read(identity)).toEqual(savedCapture)
      expect(source.source.inspectDestination(request(), context())).toEqual(status)
    }
    if (retired === false) {
      const lostResponse = new AbortController()
      const prepare = host.runtime.prepareCapturedPtyDestination.bind(host.runtime)
      const intercepted = vi.spyOn(host.runtime, 'prepareCapturedPtyDestination')
      intercepted.mockImplementationOnce(async (capture) => {
        const result = await prepare(capture)
        lostResponse.abort(new Error('Client lost publication response'))
        return result
      })
      await expect(
        recoverOutgoingOrcadCapture(desktop, { identity, signal: lostResponse.signal })
      ).rejects.toThrow()
      intercepted.mockRestore()
      expect(host.registry.get(identity.bridgeId)?.snapshot().phase).toBe('published')
    }
    const initialResponse = await recoverOutgoingOrcadCapture(desktop, {
      identity,
      signal: source.controller.signal
    })
    expect(outgoing.read(identity)).toEqual(savedCapture)
    const prepared = readCapturedPtyPublicationRetry(
      retryRequest,
      host.registry.getPublishedDelegatedDestination(identity)
    )
    expect(initialResponse).toEqual({
      version: 1,
      outcome: 'published',
      identity,
      importReceipt: prepared.importReceipt,
      publicationReceipt: prepared.publicationReceipt
    })
    lifecycle.trackPublishedDestination(identity)
    await expect
      .poll(() => lifecycle.supervisor.getConnection(identity)?.isCommitReconciled())
      .toBe(true)
    await expect.poll(() => prepared.outputOutbox.load(identity)?.acknowledgedEndSeq).toBe(2)
    const outputBeforeRetry = prepared.outputOutbox.load(identity)
    const claimBeforeRetry = source.source.inspectDestination(request(), context()).destinationClaim
    const retried = await host.runtime.prepareCapturedPtyDestination(retryRequest)
    expect(retried.publicationReceipt).toEqual(prepared.publicationReceipt)
    expect(retried.importReceipt).toEqual(prepared.importReceipt)
    const wireRetry = await sendRemoteRuntimeRequest(
      pairing,
      PTY_CAPTURED_DESTINATION_PREPARE_METHOD,
      { version: 1, identity, source: retryRequest.source, model: retryRequest.model },
      15_000,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(wireRetry).toMatchObject({
      ok: true,
      result: {
        version: 1,
        outcome: 'published',
        identity,
        importReceipt: prepared.importReceipt,
        publicationReceipt: prepared.publicationReceipt
      }
    })
    if (!wireRetry.ok) {
      throw new Error(wireRetry.error.message)
    }
    expect(Object.keys(wireRetry.result as object).sort()).toEqual([
      'identity',
      'importReceipt',
      'outcome',
      'publicationReceipt',
      'version'
    ])
    const mobileOffer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'capture-mobile',
      scope: 'mobile'
    })
    if (!mobileOffer.available) {
      throw new Error('Mobile pairing unavailable')
    }
    const mobileRetry = await sendRemoteRuntimeRequest(
      parsePairingCode(mobileOffer.pairingUrl)!,
      PTY_CAPTURED_DESTINATION_PREPARE_METHOD,
      { version: 1, identity, source: retryRequest.source, model: retryRequest.model },
      15_000,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(mobileRetry.ok).toBe(false)
    expect(prepared.outputOutbox.load(identity)).toEqual(outputBeforeRetry)
    expect(source.source.inspectDestination(request(), context()).destinationClaim).toEqual(
      claimBeforeRetry
    )
    await expect(
      host.runtime.prepareCapturedPtyDestination({
        ...retryRequest,
        model: { ...source.model, modelSequenceEnd: source.model.modelSequenceEnd + 1 }
      })
    ).rejects.toThrow('model_conflict')
    expect(initializeModel).toHaveBeenCalledOnce()
    await expect
      .poll(() => host.runtime.getPtyLivenessVerdict(identity.terminalId)?.status)
      .toBe('live')
    expect(bindConnection).toHaveBeenCalledWith(
      identity,
      lifecycle.supervisor.getConnection(identity)
    )
    await expect(
      getProviderForPty(identity.terminalId).attach(identity.terminalId)
    ).resolves.toMatchObject({
      providerSequence: { value: 100 + suffix.length, generation: 'continued' }
    })
    const model = await host.runtime.serializeMainTerminalBuffer(binding.ptyId)
    expect(model?.data.match(/after capture/g)).toHaveLength(1)
    const provider = getProviderForPty(identity.terminalId)
    await expect(provider.getCwd(identity.terminalId)).resolves.toBe('/host/current')
    await expect(provider.probePtyLiveness!(identity.terminalId)).resolves.toBe(true)
    vi.spyOn(getLocalPtyProvider(), 'listProcesses').mockResolvedValue([
      { id: identity.terminalId, cwd: '/stale-native', title: '', incarnationId: 'old-native' }
    ])
    const inventory = await listProcessesWithHostScopeFromRuntimeController(
      { runtime: host.runtime } as never,
      {
        deadlineMs: Date.now() + 2000
      }
    )
    expect(inventory.hostIds).toEqual(['local'])
    expect(inventory.processes).toEqual([
      expect.objectContaining({
        id: identity.terminalId,
        incarnationId: identity.incarnationId,
        cwd: '/host/current',
        rootProcessId: 42
      })
    ])
    const sourceBeforeCredit = source.source.inspectDestination(request(), context())
    provider.acknowledgeDataEvent(identity.terminalId, 10000)
    expect(source.source.inspectDestination(request(), context())).toEqual(sourceBeforeCredit)
    const clearSequence = host.runtime.getPtyOutputSequence(identity.terminalId)
    await expect(host.runtime.clearHeadlessTerminalBuffer(identity.terminalId)).rejects.toThrow(
      'requires_provider'
    )
    const [terminal] = (await host.runtime.listTerminals()).terminals
    expect(terminal).toBeDefined()
    vi.spyOn(provider, 'clearBuffer').mockRejectedValueOnce(new Error('clear unavailable'))
    await expect(host.runtime.clearTerminalBuffer(terminal.handle)).rejects.toThrow(
      'clear unavailable'
    )
    expect(prepared.outputOutbox.loadModelClear(identity)).toBeNull()
    await expect(host.runtime.clearTerminalBuffer(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      cleared: true
    })
    const clearIds = prepared.outputOutbox.loadModelClear(identity)!.operationIds
    expect(clearIds).toHaveLength(1)
    expect(host.runtime.getPtyOutputSequence(identity.terminalId)).toBe(clearSequence)
    source.source.observeOutput(identity.terminalId, 'after socket clear\r\n')
    await expect.poll(() => prepared.outputOutbox.load(identity)?.acknowledgedEndSeq).toBe(3)
    expect((await provider.getBufferSnapshot!(identity.terminalId))?.data).toContain(
      'after socket clear'
    )
    await provider.clearBuffer(identity.terminalId, { operationId: clearIds[0] })
    expect((await provider.getBufferSnapshot!(identity.terminalId))?.data).toContain(
      'after socket clear'
    )
    vi.spyOn(prepared.outputOutbox, 'recordModelClear').mockImplementationOnce(() => {
      throw new Error('clear journal unavailable')
    })
    await expect(
      provider.clearBuffer(identity.terminalId, { operationId: 'retry-clear' })
    ).rejects.toThrow('clear journal unavailable')
    source.source.observeOutput(identity.terminalId, 'held during failed clear\r\n')
    await expect.poll(() => prepared.outputOutbox.load(identity)?.acceptedEndSeq).toBe(4)
    await expect.poll(() => onError.mock.calls.length).toBeGreaterThan(0)
    for (const call of onError.mock.calls) {
      expect(call[1]).toMatchObject({ message: 'pty_ownership_transfer_model_ingress_unavailable' })
    }
    expect(prepared.outputOutbox.load(identity)?.acknowledgedEndSeq).toBe(3)
    onError.mockClear()
    await provider.clearBuffer(identity.terminalId, { operationId: 'retry-clear' })
    await expect.poll(() => prepared.outputOutbox.load(identity)?.acknowledgedEndSeq).toBe(4)
    expect((await provider.getBufferSnapshot!(identity.terminalId))?.data).toContain(
      'held during failed clear'
    )
    expect(onError).not.toHaveBeenCalled()
    if (retired) {
      const finalModel = prepared.outputOutbox.loadRestorableModel(identity)
      const firstExit = vi.fn()
      const secondExit = vi.fn()
      provider.onExit(firstExit)
      provider.onExit(secondExit)
      let failRetirement = retired === 'interrupted'
      const recordRetirement = prepared.outputOutbox.recordRetirement.bind(prepared.outputOutbox)
      vi.spyOn(prepared.outputOutbox, 'recordRetirement').mockImplementation((target, value) => {
        if (failRetirement && (value as { phase: string }).phase === 'applied') {
          throw new Error('retirement write interrupted')
        }
        recordRetirement(target, value)
      })
      source.source.observeExit(identity.terminalId, identity.incarnationId, 17)
      if (retired === 'interrupted') {
        await expect
          .poll(() => prepared.outputOutbox.loadRetirement(identity)?.phase)
          .toBe('prepared')
        await lifecycle.supervisor.getConnection(identity)?.dispose()
        failRetirement = false
        await source.close()
        close = undefined
        onError.mockClear()
      }
      await expect
        .poll(() => prepared.outputOutbox.loadRetirement(identity)?.phase, { timeout: 5_000 })
        .toBe('applied')
      await expect.poll(() => lifecycle.supervisor.getConnection(identity)).toBeNull()
      if (retired === 'interrupted') {
        expect(firstExit).not.toHaveBeenCalled()
        expect(secondExit).not.toHaveBeenCalled()
      } else {
        expect(firstExit).toHaveBeenCalledExactlyOnceWith({
          id: identity.terminalId,
          incarnationId: identity.incarnationId,
          code: 17
        })
        expect(secondExit).toHaveBeenCalledOnce()
      }
      expect(prepared.outputOutbox.loadRestorableModel(identity)).toEqual(finalModel)
      expect(prepared.outputOutbox.loadModelClear(identity)?.operationIds).toEqual([
        ...clearIds,
        'retry-clear'
      ])
      expect(() => getProviderForPty(identity.terminalId)).toThrow('exited')
      await expect(
        listProcessesWithHostScopeFromRuntimeController({ runtime: host.runtime } as never)
      ).resolves.toEqual({ processes: [], hostIds: ['local'] })
      await lifetime.stop()
      await close?.()
      close = undefined
      const reopened = runtimeFor()
      const reopenedLifetime = new OrcadRuntimeLifetime(vi.fn())
      lifetimes.push(reopenedLifetime)
      const restore = vi.fn(async () => {})
      installOrcadDelegatedRecovery({
        enabled: true,
        registry: reopened.registry,
        lifetime: reopenedLifetime,
        recoverRetirement: reopened.runtime.recoverDelegatedPtyRetirement,
        initializeModel: restore,
        prepareModelFrame: vi.fn(async () => {}),
        onError
      })
      expect(reopened.registry.get(identity.bridgeId)).toBeNull()
      expect(restore).not.toHaveBeenCalled()
      expect(
        reopened.store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
      ).toBeUndefined()
      expect(prepared.outputOutbox.loadRestorableModel(identity)).toEqual(finalModel)
      expect(onError).not.toHaveBeenCalled()
      expect(removeBinding).toHaveBeenCalledOnce()
      expect(release).toHaveBeenCalledOnce()
      return
    }
    await lifetime.stop()
    expect(release).toHaveBeenCalledOnce()
    expect(removeBinding).toHaveBeenCalledOnce()
    expect(() => getProviderForPty(identity.terminalId)).toThrow('unverifiable')
    await expect(
      listProcessesWithHostScopeFromRuntimeController({ runtime: host.runtime } as never)
    ).rejects.toThrow('inventory_unverifiable')
    expect(prepared.adapter.snapshot().executionVerdict).toBe('unverifiable')
    expect(host.runtime.getPtyLivenessVerdict(identity.terminalId)?.status).toBe('unverifiable')
    expect(() => lifecycle.trackPublishedDestination(identity)).toThrow()
  }
)

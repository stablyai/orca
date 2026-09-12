import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import { SshPtyProvider } from '../main/providers/ssh-pty-provider'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../shared/pty-ownership-transfer-release-gate'
import { prepareOutgoingOrcadSource } from '../main/ssh/orcad-outgoing-source-preparation'
import { OrcadOutgoingPreparationStore } from '../main/ssh/orcad-outgoing-preparation-store'
import { OrcadOutgoingPreparationDrainReceiptStore } from '../main/ssh/orcad-outgoing-preparation-drain-receipt'
import { RelayDispatcher } from './dispatcher'
import { IMMEDIATE_PTY_EXIT_TIMEOUT_MS, PtyHandler } from './pty-handler'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import * as secure from '../shared/secure-file'
import {
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'

const native = vi.hoisted(() => ({
  pid: process.pid,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn()
}))
const registry = vi.hoisted(() => ({ provider: vi.fn() }))
vi.mock('../main/ipc/pty/provider/registry', () => ({
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.provider
}))
vi.mock('node-pty', () => ({ spawn: () => ({ ...native }) }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: () => ({ notifyOutput: vi.fn(), dispose: vi.fn() })
}))

let directory: string
let cleanup: (() => Promise<void>) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  directory = mkdtempSync(join(tmpdir(), 'orca-preparation-drain-'))
})
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function setup() {
  let receive: (data: Buffer) => void = () => {}
  let drainTransport = () => {}
  let saturated = false
  const dispatcher = new RelayDispatcher(
    (data, settled) => {
      receive(data)
      settled({ ok: true })
      return true
    },
    { supportsWriteCallback: true },
    {
      principal: 'drain-owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    }
  )
  const mux = new SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write: (data, settled) => {
      dispatcher.feed(data)
      settled!({ ok: true })
      return !saturated
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {},
    onDrain: (callback) => {
      drainTransport = callback
    }
  })
  const handler = new PtyHandler(dispatcher, undefined, 'preparation-drain')
  const consumer = new SshPtyConsumerSessionAdapter(
    dispatcher,
    'drain-build',
    (id, paused) => handler.setConsumerDeliveryPaused(id, paused),
    (id) => handler.handleSourceCreditAvailable(id)
  )
  handler.setConsumerIdentityResolver((id) => consumer.clientInstanceIdFor(id))
  const publication = new RelayPtySourcePublication(dispatcher, consumer, (id) =>
    handler.handleSourcePublicationCapacity(id)
  )
  handler.setSourcePublication(publication)
  const provider = new SshPtyProvider('target', mux, undefined, 1)
  const testOwnedTerminalIds = new Set<string>()
  cleanup = async () => {
    provider.dispose()
    mux.dispose()
    for (const id of testOwnedTerminalIds) {
      handler.setOwnershipTransferInputFenced(id, false)
    }
    await handler.dispose({ waitForPhysicalExit: false })
    dispatcher.dispose()
  }
  await mux.request('pty.openClient', {
    protocolVersion: 1,
    clientInstanceId: 'drain-desktop',
    requestedRole: 'session-owner',
    capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
  })
  const spawned = (await mux.request('pty.spawn', {})) as { id: string }
  testOwnedTerminalIds.add(spawned.id)
  const source = publication.ownershipTransfer.resolve(spawned.id)!
  expect(source).not.toBeNull()
  const identity = { ...source, bridgeId: 'drain-bridge', destinationRuntimeId: 'host-orcad' }
  vi.spyOn(provider, 'getOwnershipTransferSourceIdentity').mockImplementation(() =>
    publication.ownershipTransfer.resolve(spawned.id)
  )
  const fence = vi.spyOn(handler, 'setOwnershipTransferInputFenced')
  const hostStore = new RelayPtyOwnershipTransferFileStore(directory)
  const transfer = makeDelegatedRelay(hostStore, {
    authorizeRequest: () => true,
    resolveSource: (id) => publication.ownershipTransfer.resolve(id),
    setInputFenced: (id, fenced) => handler.setOwnershipTransferInputFenced(id, fenced)
  })
  handler.setOwnershipTransferOutputObserver(transfer)
  transfer.register(dispatcher)
  const receipts = new OrcadOutgoingPreparationDrainReceiptStore(directory)
  const prepareHost = transfer.prepare.bind(transfer)
  const prepare = vi.spyOn(transfer, 'prepare').mockImplementation((...args) => {
    expect(receipts.read(identity)).toMatchObject({ identity, scope: 'bound-mux-lifetime' })
    return prepareHost(...args)
  })
  registry.provider.mockReturnValue(provider)
  vi.spyOn(provider, 'getOwnershipBridgeCapabilities').mockResolvedValue({
    protocolVersions: [1],
    maxReplayBytes: 1024,
    maxInputIds: 32,
    inputDeduplication: true,
    rollback: true,
    liveTransfer: true,
    statusQuery: true,
    preparationShutdownGuardVersion: 1,
    transferGraceGuardVersion: 1,
    transferLifecycleGuardVersion: 1,
    destinationDelegationVersion: 1,
    captureBoundaryVersion: 1,
    captureSelectionVersion: 1
  })
  const drainAndPrepare = (recoverDurability = false) =>
    prepareOutgoingOrcadSource({
      recoverDurability,
      store: new OrcadOutgoingPreparationStore(directory),
      ptyId: `ssh:target@@${identity.terminalId}`,
      signal: new AbortController().signal,
      assertAuthority: () => {},
      preparation: {
        version: 1,
        kind: 'preparation',
        identity,
        destinationEnvironmentId: 'destination',
        sourceSshTargetId: 'target',
        sourceSshTargetGeneration: 1,
        source: {
          version: 1,
          proof: { ...request(), ...identity },
          endpoint: '/registered.sock',
          incumbentVersion: 'registered-build',
          endpointCredential: 'registered-credential'
        },
        surfaceBinding: {
          ...preparation.surfacePublication.surfaceBinding,
          ptyId: identity.terminalId
        }
      }
    })
  return {
    mux,
    provider,
    identity,
    fence,
    prepare,
    receipts,
    hostStore,
    drainAndPrepare,
    saturate: () => {
      saturated = true
    },
    resume: () => {
      saturated = false
      drainTransport()
    }
  }
}

it('applies queued input and resize in the real handler before preparation fences native input', async () => {
  const fixture = await setup()
  const id = fixture.identity.terminalId
  fixture.saturate()
  fixture.provider.write(id, 'first')
  fixture.provider.write(id, 'second')
  fixture.mux.notify('pty.resize', { id, cols: 91, rows: 32 })
  const preparing = fixture.drainAndPrepare()
  await vi.advanceTimersByTimeAsync(0)
  expect(native.write.mock.calls).toEqual([['first']])
  expect(fixture.prepare).not.toHaveBeenCalled()
  expect(fixture.receipts.read(fixture.identity)).toBeNull()
  await expect(fixture.provider.writeWithSettlement(id, 'late')).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'write_gate_denied'
  })
  fixture.resume()
  await preparing
  expect(native.write.mock.calls).toEqual([['first'], ['second']])
  expect(native.resize).toHaveBeenCalledWith(91, 32)
  expect(fixture.fence).toHaveBeenCalledWith(id, true)
  expect(fixture.receipts.read(fixture.identity)).toMatchObject({
    identity: fixture.identity,
    kind: 'mux-control-drain',
    scope: 'bound-mux-lifetime'
  })
  const fencedAt = fixture.fence.mock.invocationCallOrder[0]
  expect(native.write.mock.invocationCallOrder[1]).toBeLessThan(fencedAt)
  expect(native.resize.mock.invocationCallOrder.at(-1)).toBeLessThan(fencedAt)
})

it('waits for asynchronous host shutdown and refuses preparation after physical exit', async () => {
  const fixture = await setup()
  const shutdown = fixture.mux.request('pty.shutdown', {
    id: fixture.identity.terminalId,
    immediate: true
  })
  const settled = vi.fn()
  void shutdown.then(settled)
  const preparing = fixture.drainAndPrepare().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(native.kill).toHaveBeenCalled()
  expect(settled).not.toHaveBeenCalled()
  expect(fixture.prepare).not.toHaveBeenCalled()
  const exit = native.onExit.mock.calls[0][0] as (event: { exitCode: number }) => void
  exit({ exitCode: 0 })
  await shutdown
  expect(await preparing).toBeInstanceOf(Error)
  expect(settled).toHaveBeenCalledOnce()
  expect(fixture.prepare).not.toHaveBeenCalled()
  expect(fixture.fence).not.toHaveBeenCalled()
})

it('retains the real source admission fence when drain receipt persistence fails', async () => {
  const fixture = await setup()
  const write = secure.writeDurableSecureJsonFile
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementation((path, value) =>
    String(path).includes('orcad-outgoing-preparation-drains') ? false : write(path, value)
  )
  await expect(fixture.drainAndPrepare()).rejects.toThrow('permissions_unconfirmed')
  expect(fixture.prepare).not.toHaveBeenCalled()
  expect(fixture.receipts.read(fixture.identity)).toBeNull()
  expect(new OrcadOutgoingPreparationStore(directory).read(fixture.identity)).not.toBeNull()
  await expect(
    fixture.provider.writeWithSettlement(fixture.identity.terminalId, 'late')
  ).resolves.toMatchObject({ outcome: 'refused', reason: 'write_gate_denied' })
  expect(native.write).not.toHaveBeenCalled()
})

it('explicitly recovers a host journal failure over the real mux without reopening native input', async () => {
  const fixture = await setup()
  vi.spyOn(fixture.hostStore, 'save').mockImplementationOnce(() => {
    throw new Error('host fsync failed')
  })
  await expect(fixture.drainAndPrepare()).rejects.toThrow('host fsync failed')
  await expect(fixture.drainAndPrepare()).rejects.toThrow('delegation_write_unverifiable')
  await expect(fixture.drainAndPrepare(true)).resolves.toMatchObject({
    prepared: { phase: 'prepared' }
  })
  expect(fixture.hostStore.loadAll()).toHaveLength(1)
  expect(fixture.fence.mock.calls).toEqual([[fixture.identity.terminalId, true]])
  await expect(
    fixture.provider.writeWithSettlement(fixture.identity.terminalId, 'late')
  ).resolves.toMatchObject({ outcome: 'refused', reason: 'write_gate_denied' })
  expect(native.write).not.toHaveBeenCalled()
})

it('retains a host shutdown timeout as unresolved even after the RPC leaves the pending map', async () => {
  const fixture = await setup()
  const shutdown = fixture.mux
    .request('pty.shutdown', {
      id: fixture.identity.terminalId,
      immediate: true
    })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(IMMEDIATE_PTY_EXIT_TIMEOUT_MS + 1)
  expect(await shutdown).toMatchObject({
    message: expect.stringContaining('Timed out waiting for PTY process exit')
  })
  await expect(fixture.drainAndPrepare()).rejects.toThrow()
  expect(fixture.prepare).not.toHaveBeenCalled()
  expect(fixture.fence).not.toHaveBeenCalled()
})

it('refuses a source with acknowledged graceful shutdown without canceling its pending kill', async () => {
  const fixture = await setup()
  const id = fixture.identity.terminalId
  await fixture.mux.request('pty.shutdown', { id, immediate: false })
  expect(native.kill.mock.calls).toEqual([process.platform === 'win32' ? [] : ['SIGTERM']])
  await expect(fixture.drainAndPrepare()).rejects.toThrow(
    'pty_ownership_transfer_source_shutdown_pending'
  )
  expect(fixture.prepare).toHaveBeenCalledOnce()
  expect(new RelayPtyOwnershipTransferFileStore(directory).loadAll()).toEqual([])
  await vi.advanceTimersByTimeAsync(5001)
  if (process.platform === 'win32') {
    expect(native.kill).toHaveBeenCalledOnce()
  } else {
    expect(native.kill).toHaveBeenCalledWith('SIGKILL')
  }
})

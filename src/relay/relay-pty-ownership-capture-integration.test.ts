import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PtyHandler } from './pty-handler'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, MessageType, type JsonRpcResponse } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { installRelayPtyOwnershipCapture } from './relay-pty-ownership-capture-installation'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../shared/pty-ownership-capture-wire'
import { parsePtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'
import { captureSshPtyModelAttempt } from '../main/ssh/ssh-pty-model-capture-attempt'
import { parsePtyOwnershipBridgeCapabilities } from '../shared/pty-ownership-bridge-validation'

const native = vi.hoisted(() => ({
  pid: 12345,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn()
}))
vi.mock('node-pty', () => ({ spawn: () => native }))
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
  directory = mkdtempSync(join(tmpdir(), 'orca-capture-integration-'))
})
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function setup(enableBaselineSelection = false) {
  const messages: (JsonRpcResponse & { method?: string; params?: Record<string, unknown> })[] = []
  const dispatcher = new RelayDispatcher(
    (data, settled) => {
      if (data[0] === MessageType.Regular) {
        messages.push(JSON.parse(data.subarray(13, 13 + data.readUInt32BE(9)).toString('utf8')))
      }
      settled({ ok: true })
      return true
    },
    { supportsWriteCallback: true },
    {
      principal: 'capture-owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    }
  )
  const handler = new PtyHandler(dispatcher, undefined, 'capture-integration')
  const consumer = new SshPtyConsumerSessionAdapter(
    dispatcher,
    'capture-build',
    (id, paused) => handler.setConsumerDeliveryPaused(id, paused),
    (id) => handler.handleSourceCreditAvailable(id)
  )
  handler.setConsumerIdentityResolver((id) => consumer.clientInstanceIdFor(id))
  const publication = new RelayPtySourcePublication(dispatcher, consumer, (id) =>
    handler.handleSourcePublicationCapacity(id)
  )
  handler.setSourcePublication(publication)
  const testOwnedTerminalIds = new Set<string>()
  let disposeCapture = () => {}
  cleanup = async () => {
    disposeCapture()
    for (const id of testOwnedTerminalIds) {
      handler.setOwnershipTransferInputFenced(id, false)
    }
    await handler.dispose({ waitForPhysicalExit: false })
    dispatcher.dispose()
  }
  let requestId = 0
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0))
    await vi.advanceTimersByTimeAsync(0)
    const response = messages.find((message) => message.id === id)
    expect(response, method).toBeDefined()
    if (response!.error) {
      throw new Error(response!.error.message)
    }
    return response!.result as Record<string, unknown>
  }
  await call('pty.openClient', {
    protocolVersion: 1,
    clientInstanceId: 'capture-desktop',
    requestedRole: 'session-owner',
    capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
  })
  const spawned = await call('pty.spawn', {})
  testOwnedTerminalIds.add(String(spawned.id))
  const source = publication.ownershipTransfer.resolve(String(spawned.id))!
  expect(source).not.toBeNull()
  const identity = { ...source, bridgeId: 'captured-bridge', destinationRuntimeId: 'host-orcad' }
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const transfer = makeDelegatedRelay(store, {
    enableDestinationOutputRetention: true,
    resolveSource: (id) => publication.ownershipTransfer.resolve(id),
    hasPendingSourceOutput: (id) => handler.hasPendingOwnershipTransferOutput(id),
    setInputFenced: (id, fenced) => handler.setOwnershipTransferInputFenced(id, fenced)
  })
  handler.setOwnershipTransferOutputObserver(transfer)
  transfer.prepare({ ...preparation, ...identity })
  disposeCapture = installRelayPtyOwnershipCapture({
    enabled: true,
    enableBaselineSelection,
    handler,
    sourcePublication: publication,
    transfer,
    dispatcher
  })
  const emit = native.onData.mock.calls[0][0] as (data: string) => void
  const ack = async () => {
    const output = messages.findLast((message) => message.method === 'pty.data')!.params!
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: source.terminalId,
                clientGeneration: output.clientGeneration,
                ownerGeneration: output.ownerGeneration,
                deliveryToken: output.deliveryToken,
                creditedEndSu: output.sourceEndSu
              }
            ]
          }
        },
        ++requestId,
        0
      )
    )
    await vi.advanceTimersByTimeAsync(0)
  }
  const begin = () =>
    call(methods.begin, { version: 1, ...identity, requestId: `capture-${requestId}` })
  return { call, begin, emit, ack, identity, transfer, store, messages, dispatcher }
}

it('binds real handler drain, source credit and durable frame cursor through capture RPC', async () => {
  const fixture = await setup()
  fixture.emit('one🙂')
  await vi.advanceTimersByTimeAsync(20)
  const token = await fixture.begin()
  const inspect = () => fixture.call(methods.inspect, token)
  expect((await inspect()).boundary).toBeNull()
  await fixture.ack()
  const boundary = parsePtyOwnershipCaptureBoundary((await inspect()).boundary, fixture.identity)
  expect(boundary.throughSeq).toBe(1)
  expect(boundary.delivery.creditedEndSu).toBe(5)
  expect(fixture.store.loadAll()[0].history.frames).toMatchObject([{ seq: 1, data: 'one🙂' }])
  expect(native.resume).not.toHaveBeenCalled()
  await fixture.call(methods.release, token)
  expect(native.resume).toHaveBeenCalled()
})

it('invalidates late native output without losing it from source delivery or the journal', async () => {
  const fixture = await setup()
  const token = await fixture.begin()
  expect((await fixture.call(methods.inspect, token)).boundary).not.toBeNull()
  fixture.emit('late')
  await vi.advanceTimersByTimeAsync(20)
  await fixture.ack()
  expect((await fixture.call(methods.inspect, token)).boundary).toBeNull()
  expect(fixture.store.loadAll()[0].history.frames).toMatchObject([{ seq: 1, data: 'late' }])
  expect(fixture.messages.filter((message) => message.method === 'pty.data')).toHaveLength(1)
  fixture.dispatcher.invalidateClient('peer-closed')
  expect(native.resume).toHaveBeenCalled()
})

it('retains output after release and captures a later boundary without reusing stale authority', async () => {
  const fixture = await setup()
  const first = await fixture.begin()
  await fixture.call(methods.release, first)
  fixture.emit('after capture')
  await vi.advanceTimersByTimeAsync(20)
  await fixture.ack()
  await expect(fixture.call(methods.inspect, first)).rejects.toThrow('unavailable')
  const next = await fixture.begin()
  const boundary = parsePtyOwnershipCaptureBoundary(
    (await fixture.call(methods.inspect, next)).boundary,
    fixture.identity
  )
  expect(boundary.throughSeq).toBe(1)
  expect(boundary.delivery.creditedEndSu).toBe('after capture'.length)
  const reopened = new RelayPtyOwnershipTransferFileStore(directory)
  expect(reopened.loadAll()[0].history.frames).toEqual(fixture.store.loadAll()[0].history.frames)
  expect(reopened.loadAll()[0].history.frames).toMatchObject([{ seq: 1, data: 'after capture' }])
})

it('selects a desktop model digest through authenticated RPC before releasing capture', async () => {
  const fixture = await setup(true)
  fixture.emit('one🙂')
  await vi.advanceTimersByTimeAsync(20)
  await fixture.ack()
  const capabilities = parsePtyOwnershipBridgeCapabilities(
    await fixture.call('pty.getOwnershipBridgeCapabilities', {})
  )!
  expect(capabilities).toMatchObject({ captureBoundaryVersion: 1, captureSelectionVersion: 1 })
  const persistBeforeSelection = vi.fn(async () => undefined)
  const result = await captureSshPtyModelAttempt({
    capabilities,
    selectBaseline: true,
    persistBeforeSelection,
    identity: fixture.identity,
    route: { ptyId: 'ssh:target@@app-id', providerGeneration: 42 },
    request: async (method, params) => {
      if (method === methods.select) {
        expect(persistBeforeSelection).toHaveBeenCalledOnce()
      }
      return fixture.call(method, params)
    },
    signal: new AbortController().signal,
    runtime: {
      serializeSshPtyOwnershipCapture: async () => ({
        version: 1,
        identity: fixture.identity,
        throughSeq: 1,
        modelSequenceEnd: 100,
        modelData: 'one🙂',
        cols: 80,
        rows: 24,
        restoreMetadata: { version: 1 }
      })
    }
  })
  expect(result.selection?.boundary).toMatchObject({
    throughSeq: 1,
    delivery: { creditedEndSu: 5 }
  })
  expect(persistBeforeSelection).toHaveBeenCalledWith({
    model: result.model,
    selection: result.selection
  })
  expect(fixture.store.loadAll()[0]).toMatchObject({
    version: 10,
    issuedCaptureBoundaries: [result.boundary],
    captureBaseline: result.selection,
    replayStartSeq: 1
  })
  expect(native.resume).toHaveBeenCalled()
  fixture.emit('after selection')
  await vi.advanceTimersByTimeAsync(20)
  expect(fixture.store.loadAll()[0].history.frames).toMatchObject([
    { seq: 1, data: 'one🙂' },
    { seq: 2, data: 'after selection' }
  ])
})

it('does not expose selection RPC or capability on a capture-only host', async () => {
  const fixture = await setup()
  expect(await fixture.call('pty.getOwnershipBridgeCapabilities', {})).not.toHaveProperty(
    'captureSelectionVersion'
  )
  const token = await fixture.begin()
  await expect(fixture.call(methods.select, { ...token, baseline: {} })).rejects.toThrow()
  expect(fixture.store.loadAll()[0].captureBaseline).toBeUndefined()
})

it.each(['expired', 'released', 'late-output'])(
  'refuses selection with %s capture evidence over RPC',
  async (mode) => {
    const fixture = await setup(true)
    const token = await fixture.begin()
    const baseline = {
      version: 1,
      boundary: (await fixture.call(methods.inspect, token)).boundary,
      modelSha256: 'a'.repeat(64)
    }
    if (mode === 'expired') {
      await vi.advanceTimersByTimeAsync(5_000)
    } else if (mode === 'released') {
      await fixture.call(methods.release, token)
    } else {
      fixture.emit('late')
      await vi.advanceTimersByTimeAsync(20)
    }
    await expect(fixture.call(methods.select, { ...token, baseline })).rejects.toThrow()
    expect(fixture.store.loadAll()[0].captureBaseline).toBeUndefined()
  }
)

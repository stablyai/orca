import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import {
  context,
  identity as template,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import {
  claimRelayPtyOwnershipTransferDestination,
  recoverRelayPtyOwnershipTransferDestination
} from './relay-pty-ownership-transfer-destination-claim'
import { retireRelayPtySourceDelivery } from './relay-pty-source-retirement-execution'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD as RETIRE } from '../shared/pty-ownership-transfer-source-retirement'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD as CLAIM,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD as STATUS
} from '../shared/pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferDestinationStatus } from '../shared/pty-ownership-transfer-destination-status'
import { OrcadDelegatedTransferClient } from '../main/orcad/orcad-delegated-transfer-client'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { RelayDispatcher as SocketDispatcher } from './dispatcher'
import { setupDaemonHandshake } from './relay-handshake'
import { relayTestSocketPath } from './relay-test-socket-path'
import { connectOrcadLocalRelay } from '../main/orcad/orcad-local-relay-connection'
import { confirmSettledSourceDeliveryCancellation } from '../main/providers/ssh-pty-source-delivery-state'

const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

async function setup() {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const directory = mkdtempSync(join(tmpdir(), 'orca-source-retirement-'))
  disposals.push(() => rmSync(directory, { recursive: true, force: true }))
  const disk = new RelayPtyOwnershipTransferFileStore(directory)
  const identity = { ...template, ...f.source }
  disk.save({
    version: 5,
    identity,
    phase: 'committed',
    destinationDelegation: preparation.destinationDelegation,
    surfacePublication: {
      ...preparation.surfacePublication,
      surfaceBinding: {
        ...preparation.surfacePublication.surfaceBinding,
        ptyId: identity.terminalId
      }
    },
    destinationOutputRetention: true,
    destinationClaim: { generation: 1, claimId: 'claim-1' },
    sourceOutputEndSeq: 0,
    replayStartSeq: 1,
    history: { nextSeq: 1, frames: [] },
    acceptedInputs: [],
    acceptedControls: [],
    commitReceipt: {
      bridgeId: identity.bridgeId,
      receiptId: 'commit',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-07T00:00:00.000Z'
    }
  })
  let failure: { phase: 'prepared' | 'retired'; when: 'before' | 'after' } | undefined
  const store = {
    loadAll: () => disk.loadAll(),
    remove: (id: string) => disk.remove(id),
    save: vi.fn((record: RelayPtyOwnershipTransferDurableRecord) => {
      const fails = !!failure && failure.phase === record.sourceDeliveryRetirement?.phase
      if (!fails || failure?.when !== 'before') {
        disk.save(record)
      }
      if (fails) {
        throw new Error('retirement write uncertain')
      }
    })
  }
  const state = newRelayPtyOwnershipTransferAdapterState({
    options: {
      store,
      enableDestinationDelegationClaims: true,
      enableDestinationDelegationCommit: true,
      resolveSource: (id) => f.publication.ownershipTransfer.resolve(id),
      authorizeRequest: () => false,
      setInputFenced: vi.fn(),
      writeDestinationInput: vi.fn(),
      publishDestinationOutput: vi.fn()
    }
  })
  let generation = 2
  const value = () => ({
    ...request(generation),
    ...identity,
    retirementRecordSha256: 'a'.repeat(64),
    destinationClaim: { generation, claimId: `claim-${generation}` }
  })
  claimRelayPtyOwnershipTransferDestination(state, value(), context())
  const prepare = vi.fn(f.prepare)
  const cancelOriginal = f.session.cancelDelivery.bind(f.session)
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  return {
    ...f,
    state,
    prepare,
    cancel,
    cancelOriginal,
    store,
    disk,
    directory,
    identity,
    run: () => retireRelayPtySourceDelivery(state, value(), context(), prepare),
    fail: (next: typeof failure) => {
      failure = next
    },
    recover: () => {
      recoverRelayPtyOwnershipTransferDestination(state, value(), context())
      generation++
      claimRelayPtyOwnershipTransferDestination(state, value(), context())
    }
  }
}

it('retires an actual source publication through authenticated local socket transport', async () => {
  const f = await setup()
  const output = 'socket retirement\r\n🌊'
  f.publication.publish('source', { data: output }, false)
  await f.acknowledge('source', output.length)
  const delivery = f.prepare().delivery
  const adapter = new RelayPtyOwnershipTransferAdapter({
    ...f.state.options,
    enableSourceDeliveryRetirement: true,
    prepareSourceDeliveryRetirement: (identity, expected) =>
      f.publication.prepareOwnershipTransferRetirement(identity, undefined, expected)
  })
  const sockets = new Set<Socket>()
  const endpoint = relayTestSocketPath(f.directory)
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    setupDaemonHandshake(socket, {
      launchVersion: 'retirement-build',
      endpointCredential: 'retirement-endpoint',
      onAccepted: (connection, leftover) => {
        const dispatcher = new SocketDispatcher(
          (data, settle) =>
            connection.write(data, (error) => settle(error ? { ok: false, error } : { ok: true })),
          { supportsWriteCallback: true },
          {
            principal: 'host-local',
            authenticated: true,
            allowSessionOwner: false,
            authenticationKind: 'endpoint-credential'
          }
        )
        adapter.register(dispatcher)
        socket.once('close', () => dispatcher.dispose())
        socket.on('data', (data: Buffer) => dispatcher.feed(data))
        if (leftover.length) {
          dispatcher.feed(leftover)
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  let connection: Awaited<ReturnType<typeof connectOrcadLocalRelay>> | undefined
  try {
    connection = await connectOrcadLocalRelay({
      endpoint,
      incumbentVersion: 'retirement-build',
      endpointCredential: 'retirement-endpoint',
      initialize: () => {}
    })
    const transport = connection
    const client = new OrcadDelegatedTransferClient((method, params, options) =>
      transport.request(method, { ...params }, options)
    )
    const proof = { ...request(3), ...f.identity }
    await client.claim(proof)
    const value = {
      ...proof,
      retirementRecordSha256: 'a'.repeat(64),
      destinationClaim: { generation: 3, claimId: 'claim-3' }
    }
    await expect(
      client.retireSourceDelivery(value, { ...delivery, deliveryToken: 'other' })
    ).rejects.toThrow()
    expect(f.publication.accepts('source')).toBe(true)
    const retired = await client.retireSourceDelivery(value, delivery)
    expect(await client.retireSourceDelivery(value, delivery)).toEqual(retired)
    expect(f.publication.accepts('source')).toBe(false)
    expect(f.publication.publish('other', { data: 'sibling survives' }, false)).toBe(true)
    expect(f.session.sourceDeliverySnapshotIfKnown(delivery)).toMatchObject({
      state: 'closed',
      creditedEndSu: output.length,
      exitPublished: false
    })
    expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toEqual(retired.sourceDeliveryRetirement)
    const confirmation = await confirmSettledSourceDeliveryCancellation(
      {
        request: async (method, params) => {
          const response = await f.request(method, { ...params })
          if (response.error) {
            throw new Error('source confirmation failed')
          }
          return response.result
        }
      },
      f.identity,
      delivery,
      () => {}
    )
    expect(confirmation.cancellation).toEqual({
      canceled: true,
      sentEndSu: output.length,
      creditedEndSu: output.length
    })
  } finally {
    connection?.dispose()
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('refuses retained retirement acknowledgment when the closed ledger disappears', async () => {
  const f = await setup()
  const retired = f.run()
  const writes = f.store.save.mock.calls.length
  const snapshot = vi.spyOn(f.session, 'sourceDeliverySnapshotIfKnown').mockReturnValue(null)
  expect(f.run).toThrow('closed_ledger_required')
  expect(f.store.save).toHaveBeenCalledTimes(writes)
  expect(f.cancel).toHaveBeenCalledOnce()
  expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toEqual(retired.sourceDeliveryRetirement)
  snapshot.mockRestore()
  expect(f.run()).toEqual(retired)
  expect(f.cancel).toHaveBeenCalledOnce()
})

it.each([
  ['prepared', 'before'],
  ['prepared', 'after'],
  ['retired', 'before'],
  ['retired', 'after']
] as const)(
  'resumes real source cleanup after %s write failure %s disk save',
  async (phase, when) => {
    const f = await setup()
    f.fail({ phase, when })
    expect(f.run).toThrow('retirement write uncertain')
    expect(f.publication.accepts('source')).toBe(phase === 'prepared')
    expect(f.cancel).toHaveBeenCalledTimes(phase === 'prepared' ? 0 : 1)
    expect(f.publication.accepts('other')).toBe(true)
    f.fail(undefined)
    f.recover()
    const result = f.run()
    expect(result.sourceDeliveryRetirement.phase).toBe('retired')
    expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toEqual(result.sourceDeliveryRetirement)
    expect(f.publication.accepts('source')).toBe(false)
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.prepare).toHaveBeenCalledOnce()
    f.run()
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.publication.publish('other', { data: 'sibling still live' }, false)).toBe(true)
    expect(f.writes.some((frame) => frame.includes(Buffer.from('pty.exit')))).toBe(false)
  }
)

it('resumes a real cancellation that closes the ledger and then throws before record removal', async () => {
  const f = await setup()
  f.cancel.mockImplementationOnce((...args) => {
    f.cancelOriginal(...args)
    throw new Error('cancellation reply failed')
  })
  expect(f.run).toThrow('cancellation reply failed')
  expect(f.disk.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('prepared')
  expect(f.publication.accepts('source')).toBe(true)
  expect(f.run().sourceDeliveryRetirement.phase).toBe('retired')
  expect(f.publication.accepts('source')).toBe(false)
  expect(f.cancel).toHaveBeenCalledTimes(2)
  expect(f.prepare).toHaveBeenCalledOnce()
})

it('refuses real uncredited source output before writing retirement intent', async () => {
  const f = await setup()
  const writesBefore = f.store.save.mock.calls.length
  expect(f.publication.publish('source', { data: 'uncredited output' }, false)).toBe(true)
  expect(f.run).toThrow('drained_delivery_required')
  expect(f.store.save).toHaveBeenCalledTimes(writesBefore)
  expect(f.cancel).not.toHaveBeenCalled()
  expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toBeUndefined()
})

it('records the exact nonempty source-unit boundary only after the real owner ACK', async () => {
  const f = await setup()
  const output = 'before transfer\r\n🌊'
  expect(f.publication.publish('source', { data: output }, false)).toBe(true)
  expect(f.run).toThrow('drained_delivery_required')
  await f.acknowledge('source', output.length)
  const result = f.run()
  expect(result.sourceDeliveryRetirement.delivery).toMatchObject({
    receivedEndSu: output.length,
    sentEndSu: output.length,
    creditedEndSu: output.length
  })
  expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toEqual(result.sourceDeliveryRetirement)
  expect(f.writes.some((frame) => frame.includes(Buffer.from(JSON.stringify(output))))).toBe(true)
  expect(f.publication.accepts('source')).toBe(false)
})

it.each(['exact', 'before', 'after'] as const)(
  'runs authenticated registered-client retirement and reload recovery with %s reflush',
  async (mode) => {
    const f = await setup()
    const prepare = vi.fn(
      (identity: PtyOwnershipTransferWireIdentity, expected?: PtySourceDeliverySnapshot) =>
        f.publication.prepareOwnershipTransferRetirement(identity, undefined, expected)
    )
    const register = () => {
      const adapter = new RelayPtyOwnershipTransferAdapter({
        ...f.state.options,
        enableSourceDeliveryRetirement: true,
        prepareSourceDeliveryRetirement: prepare
      })
      const handlers = new Map<string, MethodHandler>()
      adapter.register({
        onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler),
        onLegacyPtyCapacity: () => () => {},
        onClientDetached: () => () => {},
        onDisposed: () => () => {}
      } as unknown as RelayDispatcher)
      return handlers
    }
    let handlers = register()
    const proof = { ...request(3), ...f.identity }
    await handlers.get(CLAIM)!(proof, context())
    const status = await handlers.get(STATUS)!(proof, context())
    expect(parsePtyOwnershipTransferDestinationStatus(status).sourceRetirementVersion).toBe(1)
    const value = {
      ...proof,
      retirementRecordSha256: 'a'.repeat(64),
      destinationClaim: { generation: 3, claimId: 'claim-3' }
    }
    await expect(
      handlers.get(RETIRE)!({ ...value, credential: '0'.repeat(64) }, context())
    ).rejects.toThrow()
    expect(prepare).not.toHaveBeenCalled()
    const expectedDelivery = f.publication.prepareOwnershipTransferRetirement(f.identity).delivery
    const client = new OrcadDelegatedTransferClient(async (method, params) =>
      handlers.get(method)!({ ...params }, context())
    )
    const result = await client.retireSourceDelivery(value, expectedDelivery)
    expect(result).toMatchObject({ sourceDeliveryRetirement: { phase: 'retired' } })
    expect(prepare).toHaveBeenCalledExactlyOnceWith(f.identity, undefined)
    expect(f.publication.accepts('source')).toBe(false)
    expect(f.publication.accepts('other')).toBe(true)
    expect(f.disk.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('retired')
    const cancellations = f.cancel.mock.calls.length
    handlers = register()
    await expect(client.retireSourceDelivery(value, expectedDelivery)).rejects.toThrow(
      'claim_mismatch'
    )
    expect(prepare).toHaveBeenCalledOnce()
    await client.claim({ ...request(4), ...f.identity })
    let resumed = { ...value, destinationClaim: { generation: 4, claimId: 'claim-4' } }
    if (mode !== 'exact') {
      f.fail({ phase: 'retired', when: mode })
      await expect(client.retireSourceDelivery(resumed, expectedDelivery)).rejects.toThrow(
        'retirement write uncertain'
      )
      f.fail(undefined)
      await expect(client.retireSourceDelivery(resumed, expectedDelivery)).rejects.toThrow()
      await client.recover(resumed)
      await client.claim({ ...request(5), ...f.identity })
      resumed = { ...value, destinationClaim: { generation: 5, claimId: 'claim-5' } }
    }
    await expect(client.retireSourceDelivery(resumed, expectedDelivery)).resolves.toEqual(result)
    await expect(
      client.retireSourceDelivery({ ...resumed, recoveryOnly: true }, expectedDelivery)
    ).resolves.toEqual({
      ...result,
      sourceCancellation: {
        canceled: true,
        sentEndSu: expectedDelivery.sentEndSu,
        creditedEndSu: expectedDelivery.creditedEndSu
      }
    })
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenLastCalledWith(f.identity, expectedDelivery)
    expect(f.cancel).toHaveBeenCalledTimes(cancellations)
    expect(f.publication.accepts('other')).toBe(true)
  }
)

it.each(['exact', 'advanced-output', 'wrong-hash', 'unbound', 'removed'])(
  'reconstructs prepared retirement only with fresh exact delivery and destination authority: %s',
  async (mode) => {
    const f = await setup()
    f.fail({ phase: 'prepared', when: 'after' })
    expect(f.run).toThrow('retirement write uncertain')
    expect(f.cancel).not.toHaveBeenCalled()
    f.fail(undefined)
    if (mode === 'removed') {
      f.prepare().remove(() => {})
      f.cancel.mockClear()
    }
    const restarted = newRelayPtyOwnershipTransferAdapterState({ options: f.state.options })
    const value = {
      ...request(3),
      ...f.identity,
      retirementRecordSha256: (mode === 'wrong-hash' ? 'b' : 'a').repeat(64),
      destinationClaim: { generation: 3, claimId: 'claim-3' }
    }
    if (mode !== 'unbound') {
      claimRelayPtyOwnershipTransferDestination(restarted, value, context())
    }
    if (mode === 'advanced-output') {
      f.publication.publish('source', { data: 'new' }, false)
      await f.acknowledge('source', 3)
    }
    const prepare = vi.fn(() => f.prepare())
    const writesBefore = f.store.save.mock.calls.length
    const run = () => retireRelayPtySourceDelivery(restarted, value, context(), prepare)
    if (mode === 'exact') {
      expect(run().sourceDeliveryRetirement.phase).toBe('retired')
      expect(f.cancel).toHaveBeenCalledOnce()
      expect(f.publication.accepts('source')).toBe(false)
      expect(f.disk.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('retired')
      expect(
        f.store.save.mock.calls
          .slice(writesBefore)
          .map(([record]) => record.sourceDeliveryRetirement?.phase)
      ).toEqual(['prepared', 'retired'])
    } else {
      expect(run).toThrow()
      expect(f.cancel).not.toHaveBeenCalled()
      expect(f.store.save).toHaveBeenCalledTimes(writesBefore)
      expect(f.publication.accepts('source')).toBe(mode !== 'removed')
      if (mode === 'wrong-hash' || mode === 'unbound') {
        expect(prepare).not.toHaveBeenCalled()
      }
    }
    expect(f.publication.accepts('other')).toBe(true)
  }
)

it('reflushes reconstructed intent before cleanup and requires recovery after another uncertain write', async () => {
  const f = await setup()
  f.fail({ phase: 'prepared', when: 'after' })
  expect(f.run).toThrow('retirement write uncertain')
  f.fail(undefined)
  const restarted = newRelayPtyOwnershipTransferAdapterState({ options: f.state.options })
  const value = (generation: number) => ({
    ...request(generation),
    ...f.identity,
    retirementRecordSha256: 'a'.repeat(64),
    destinationClaim: { generation, claimId: `claim-${generation}` }
  })
  claimRelayPtyOwnershipTransferDestination(restarted, value(3), context())
  f.fail({ phase: 'prepared', when: 'before' })
  const prepare = vi.fn(() => f.prepare())
  const run = (generation: number) =>
    retireRelayPtySourceDelivery(restarted, value(generation), context(), prepare)
  expect(() => run(3)).toThrow('retirement write uncertain')
  expect(f.cancel).not.toHaveBeenCalled()
  expect(restarted.transfers.get(f.identity.bridgeId)?.destinationClaimBinding).toBeUndefined()
  f.fail(undefined)
  expect(() => run(3)).toThrow('claim_unavailable')
  recoverRelayPtyOwnershipTransferDestination(restarted, value(3), context())
  claimRelayPtyOwnershipTransferDestination(restarted, value(4), context())
  expect(run(4).sourceDeliveryRetirement.phase).toBe('retired')
  expect(prepare).toHaveBeenCalledOnce()
  expect(f.cancel).toHaveBeenCalledOnce()
  expect(f.publication.accepts('other')).toBe(true)
})

it.each(['after-cancellation', 'after-removal'])(
  'reconstructs prepared retirement interrupted %s',
  async (stage) => {
    const f = await setup()
    f.fail({ phase: 'prepared', when: 'after' })
    expect(f.run).toThrow('retirement write uncertain')
    f.fail(undefined)
    const expected = f.disk.loadAll()[0].sourceDeliveryRetirement!.delivery
    const interrupted = f.prepare()
    expect(() =>
      interrupted.remove(() => {
        if (
          f.session.sourceDeliverySnapshotIfKnown(expected)?.state === 'closed' &&
          (stage === 'after-cancellation' || !f.publication.accepts('source'))
        ) {
          throw new Error('interrupted after cancellation')
        }
      })
    ).toThrow('interrupted after cancellation')
    expect(f.publication.accepts('source')).toBe(stage === 'after-cancellation')
    const restarted = newRelayPtyOwnershipTransferAdapterState({ options: f.state.options })
    const value = {
      ...request(3),
      ...f.identity,
      retirementRecordSha256: 'a'.repeat(64),
      destinationClaim: { generation: 3, claimId: 'claim-3' }
    }
    claimRelayPtyOwnershipTransferDestination(restarted, value, context())
    const result = retireRelayPtySourceDelivery(restarted, value, context(), (delivery) =>
      f.publication.prepareOwnershipTransferRetirement(f.identity, undefined, delivery)
    )
    expect(result.sourceDeliveryRetirement).toMatchObject({ phase: 'retired', delivery: expected })
    expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toEqual(result.sourceDeliveryRetirement)
    expect(f.publication.accepts('source')).toBe(false)
    expect(f.publication.accepts('other')).toBe(true)
  }
)

it.each(['exact', 'write-before', 'write-after', 'replacement', 'missing-ledger'])(
  'reconstructs retired acknowledgment only with fresh absence evidence: %s',
  async (mode) => {
    const f = await setup()
    const completed = f.run()
    const cancelCount = f.cancel.mock.calls.length
    const restarted = newRelayPtyOwnershipTransferAdapterState({ options: f.state.options })
    const value = (generation: number) => ({
      ...request(generation),
      ...f.identity,
      retirementRecordSha256: 'a'.repeat(64),
      destinationClaim: { generation, claimId: `claim-${generation}` }
    })
    claimRelayPtyOwnershipTransferDestination(restarted, value(3), context())
    const run = (generation = 3) =>
      retireRelayPtySourceDelivery(restarted, value(generation), context(), (delivery) =>
        f.publication.prepareOwnershipTransferRetirement(f.identity, undefined, delivery)
      )
    const saves = f.store.save.mock.calls.length
    if (mode === 'replacement' || mode === 'missing-ledger') {
      if (mode === 'replacement') {
        f.activate('source')
      } else {
        vi.spyOn(f.session, 'sourceDeliverySnapshotIfKnown').mockReturnValue(null)
      }
      expect(() => run()).toThrow()
      expect(f.store.save).toHaveBeenCalledTimes(saves)
      expect(f.cancel).toHaveBeenCalledTimes(cancelCount)
      expect(f.publication.accepts('other')).toBe(true)
      return
    }
    let generation = 3
    if (mode !== 'exact') {
      f.fail({ phase: 'retired', when: mode === 'write-before' ? 'before' : 'after' })
      expect(() => run()).toThrow('retirement write uncertain')
      expect(restarted.transfers.get(f.identity.bridgeId)?.destinationClaimBinding).toBeUndefined()
      f.fail(undefined)
      expect(() => run()).toThrow('claim_unavailable')
      recoverRelayPtyOwnershipTransferDestination(restarted, value(3), context())
      generation = 4
      claimRelayPtyOwnershipTransferDestination(restarted, value(4), context())
    }
    expect(run(generation)).toEqual(completed)
    expect(run(generation)).toEqual(completed)
    expect(f.cancel).toHaveBeenCalledTimes(cancelCount)
    expect(f.publication.accepts('source')).toBe(false)
    expect(f.publication.accepts('other')).toBe(true)
    expect(f.disk.loadAll()[0].sourceDeliveryRetirement).toEqual(completed.sourceDeliveryRetirement)
  }
)

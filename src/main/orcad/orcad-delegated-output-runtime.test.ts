import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import {
  identity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { drainOrcadDelegatedOutput } from './orcad-delegated-output-drain'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const result = {
  ...identity,
  version: 1 as const,
  phase: 'prepared' as const,
  sourceOutputEndSeq: 2,
  replayStartSeq: 1,
  surfacePublication: preparation.surfacePublication
}
const source = {
  version: 1,
  proof: request(),
  endpoint: '/incumbent.sock',
  incumbentVersion: 'incumbent-build',
  endpointCredential: 'endpoint-secret'
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-delegated-runtime-'))
})
afterEach(() => rmSync(testState.dir, { recursive: true, force: true }))

function setup(strict = true) {
  const store = createStore()
  const deliver = vi.fn((identity, _binding, frame) => ({ identity, throughSeq: frame.seq }))
  const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: identity.destinationRuntimeId,
    store,
    publishPostCommitOutput: vi.fn(),
    ...(strict ? { publishPostCommitOutputAcknowledged: deliver } : {})
  })
  return { store, registry, deliver }
}

it('uses the runtime replay publication and output sink across destination restart', async () => {
  const fixture = setup()
  const prepared = fixture.registry.prepareDelegated(result, source)
  const drain = () =>
    drainOrcadDelegatedOutput({
      identity,
      adapter: prepared.adapter,
      outbox: prepared.outputOutbox,
      isActive: () => true
    })
  prepared.outputOutbox.enqueue(identity, { seq: 1, data: 'first\n' })
  prepared.outputOutbox.enqueue(identity, { seq: 2, data: 'second\n' })
  expect(await drain()).toMatchObject({ acknowledgedEndSeq: 2, hasPending: false })
  prepared.adapter.commit({
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 2,
    committedAt: '2026-09-06T00:00:00.000Z'
  })
  prepared.adapter.publish()
  const binding = preparation.surfacePublication.surfaceBinding
  const ref =
    fixture.store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
      ?.scrollbackRefsByLeafId?.[binding.leafId]
  expect(ref && fixture.store.readTerminalScrollbackSnapshot(ref)).toBe('first\nsecond\n')
  prepared.outputOutbox.enqueue(identity, { seq: 3, data: 'live' })
  const restarted = setup()
  const reopened = restarted.registry.recoverPersistedDelegatedDestinations()[0]
  expect(
    await drainOrcadDelegatedOutput({
      identity,
      adapter: reopened.adapter,
      outbox: reopened.outbox,
      isActive: () => true
    })
  ).toMatchObject({ acknowledgedEndSeq: 3, hasPending: false })
  expect(restarted.deliver).toHaveBeenCalledOnce()
  expect(restarted.deliver.mock.calls[0][2]).toEqual({ seq: 3, data: 'live' })
  expect(restarted.registry.listRecoveryCandidates()[0].requiresDelegatedSource).toBe(true)
})

it('requires strict model acknowledgements before creating delegated state', async () => {
  const fixture = setup(false)
  expect(() => fixture.registry.prepareDelegated(result, source)).toThrow(
    'delegated_destination_unavailable'
  )
  expect(fixture.registry.listRecoveryCandidates()).toEqual([])
})

it('refuses an ordinary outbox baseline that would skip unstaged initial replay', async () => {
  const fixture = setup()
  fixture.registry.prepare(result)
  expect(() => fixture.registry.prepareDelegated(result, source)).toThrow(
    'delegated_output_baseline_conflict'
  )
  expect(fixture.registry.listRecoveryCandidates()[0].requiresDelegatedSource).toBeUndefined()
})

it('ordinary recovery leaves delegated records for the host-owned recovery path', async () => {
  const fixture = setup()
  fixture.registry.prepareDelegated(result, source)
  const restarted = setup()
  expect(restarted.registry.recoverPersistedAdapters()).toEqual([])
  expect(restarted.registry.get(identity.bridgeId)).toBeNull()
  const recovered = restarted.registry.recoverPersistedDelegatedDestinations()
  expect(recovered).toHaveLength(1)
  expect(recovered[0].identity).toEqual(identity)
  expect(recovered[0].adapter.snapshot().surfaceBinding).toEqual(
    preparation.surfacePublication.surfaceBinding
  )
  expect(recovered[0].outbox.load(identity)).toMatchObject({ baseEndSeq: 0, acceptedEndSeq: 0 })
  expect(restarted.registry.recoverPersistedDelegatedDestinations()[0].adapter).toBe(
    recovered[0].adapter
  )
})

it('does not recreate a missing delegated outbox from the prepared source cursor', async () => {
  const fixture = setup()
  const prepared = fixture.registry.prepareDelegated(result, source)
  vi.spyOn(prepared.outputOutbox, 'load').mockReturnValue(null)
  const open = vi.spyOn(prepared.outputOutbox, 'open')
  expect(() => fixture.registry.recoverPersistedDelegatedDestinations()).toThrow(
    'delegated_recovery_unavailable'
  )
  expect(open).not.toHaveBeenCalled()
})

it('refuses delegated recovery without strict model acknowledgements', async () => {
  setup().registry.prepareDelegated(result, source)
  const restarted = setup(false)
  expect(() => restarted.registry.recoverPersistedDelegatedDestinations()).toThrow(
    'delegated_recovery_unavailable'
  )
  expect(restarted.registry.get(identity.bridgeId)).toBeNull()
})

it('delegated recovery skips ordinary records', async () => {
  const fixture = setup()
  fixture.registry.prepare(result)
  expect(fixture.registry.recoverPersistedDelegatedDestinations()).toEqual([])
})

it('delegated recovery skips records owned by another runtime', async () => {
  const fixture = setup()
  fixture.registry.prepareDelegated(result, source)
  const other = new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: 'different-runtime',
    store: fixture.store,
    publishPostCommitOutput: vi.fn(),
    publishPostCommitOutputAcknowledged: fixture.deliver
  })
  expect(other.recoverPersistedDelegatedDestinations()).toEqual([])
})

it.each(['prepared', 'applied'] as const)(
  'intercepts %s retirement before adapter/model reconstruction and never reconnects it',
  (phase) => {
    const fixture = setup()
    const baseline = { ...result, sourceOutputEndSeq: 0 }
    const prepared = fixture.registry.prepareDelegated(baseline, source)
    prepared.adapter.commit({
      bridgeId: identity.bridgeId,
      receiptId: 'retired-receipt',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    })
    prepared.adapter.publish()
    const event = {
      identity,
      surfaceBinding: preparation.surfacePublication.surfaceBinding,
      destinationClaim: { generation: 1, claimId: 'retired-owner' },
      finalOutputSeq: 0,
      exit: {
        verdict: 'exited',
        code: 0,
        eventId: 'retired-exit',
        observedAt: '2026-09-06T00:00:00Z'
      }
    }
    prepared.outputOutbox.recordRetirement(identity, { phase: 'prepared', event })
    if (phase === 'applied') {
      prepared.outputOutbox.recordRetirement(identity, { phase, event })
    }
    expect(() => fixture.registry.getPublishedDelegatedDestination(identity)).toThrow(
      'model_retired'
    )
    const restarted = setup()
    const prepare = vi.spyOn(restarted.registry, 'prepare')
    expect(() => restarted.registry.recoverPersistedDelegatedDestinations()).toThrow(
      'retirement_recovery_required'
    )
    expect(prepare).not.toHaveBeenCalled()
    expect(restarted.registry.get(identity.bridgeId)).toBeNull()
    const recover = vi.fn(({ retirement, outbox }) => {
      expect(retirement).toEqual({ phase, event })
      expect(restarted.registry.get(identity.bridgeId)).toBeNull()
      outbox.recordRetirement(identity, { ...retirement, phase: 'applied' })
    })
    expect(restarted.registry.recoverPersistedDelegatedDestinations(recover)).toEqual([])
    expect(recover).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    expect(() => restarted.registry.prepare(baseline)).toThrow('model_retired')
  }
)

it('does not republish a retired destination when its recovery callback fails or omits persistence', () => {
  const fixture = setup()
  const prepared = fixture.registry.prepareDelegated({ ...result, sourceOutputEndSeq: 0 }, source)
  prepared.adapter.commit({
    bridgeId: identity.bridgeId,
    receiptId: 'interrupted-retirement',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00.000Z'
  })
  prepared.adapter.publish()
  prepared.outputOutbox.recordRetirement(identity, {
    phase: 'prepared',
    event: {
      identity,
      surfaceBinding: preparation.surfacePublication.surfaceBinding,
      destinationClaim: { generation: 1, claimId: 'retirement' },
      finalOutputSeq: 0,
      exit: { verdict: 'exited', code: 0, eventId: 'exit', observedAt: '2026-09-06T00:00:00Z' }
    }
  })
  const restarted = setup()
  expect(() => restarted.registry.recoverPersistedDelegatedDestinations(() => {})).toThrow(
    'recovery_incomplete'
  )
  expect(() =>
    restarted.registry.recoverPersistedDelegatedDestinations(() => {
      throw new Error('workspace write failed')
    })
  ).toThrow('workspace write failed')
  expect(restarted.registry.get(identity.bridgeId)).toBeNull()
  expect(prepared.outputOutbox.loadRetirement(identity)?.phase).toBe('prepared')
})

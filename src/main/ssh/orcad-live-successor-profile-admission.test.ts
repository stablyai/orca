import { expect, it, vi } from 'vitest'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { createOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { bindOrcadLiveSuccessorProfileAdmission } from './orcad-live-successor-profile-admission'

function fixture(kind: 'folder' | 'worktree' = 'folder') {
  const f = liveSourceRetirementFixture(kind)
  const record = createOrcadLiveSourceRetirementRecord({
    state: f.state,
    sourceAdmission: f.sourceAdmission,
    release: {
      version: 1,
      cutover: f.cutover,
      activations: f.cutover.terminalPublications!.map((entry) => ({
        version: 1,
        identity: entry.identity,
        publicationReceipt: entry.publicationReceipt,
        destinationClaim: { generation: 1, claimId: 'claim' },
        catalog: entry.catalog
      }))
    }
  })
  const owner = { ...f.state.sshPtyConsumerRecoveries![0], ownerGeneration: 2, clientGeneration: 2 }
  f.state.sshPtyConsumerRecoveries = [owner]
  const { targetId, serverBuildId: _build, ...claim } = owner
  const session = {
    targetId,
    owner: { mode: 'negotiated' as const, ...claim },
    resumed: true,
    mux: { request: vi.fn(), isDisposed: () => false },
    connection: {},
    transportGeneration: 1
  }
  const options = {
    record,
    store: {
      getSshRemotePtyLeases: () => f.state.sshRemotePtyLeases,
      getSshPtyConsumerRecovery: () => f.state.sshPtyConsumerRecoveries?.[0] ?? null
    },
    retained: { readSession: vi.fn(() => session), assertCurrent: vi.fn() },
    signal: new AbortController().signal,
    assertAuthority: vi.fn(),
    assertRuntimeAbsent: vi.fn(),
    assertCancellation: vi.fn()
  }
  return {
    ...f,
    record,
    owner,
    session,
    options,
    bind: () => bindOrcadLiveSuccessorProfileAdmission(options)
  }
}

it.each(['folder', 'worktree'] as const)(
  'projects %s state with exact resumed owner evidence',
  (kind) => {
    const f = fixture(kind)
    const bound = f.bind()
    bound.assertBindings(f.cutover.liveTerminalBindings)
    const before = structuredClone(f.state)
    const candidate = bound.projectSourceState(
      f.state,
      f.cutover.manifest.source,
      f.cutover.manifest.payload
    )
    expect(candidate.sshPtyConsumerRecoveries).toEqual([])
    expect(candidate.sshRemotePtyLeases).toEqual([])
    expect(f.state).toEqual(before)
    expect(bound.owner).toEqual(f.owner)
    expect(Object.isFrozen(bound.owner)).toBe(true)
    expect(f.options.assertCancellation).toHaveBeenCalledWith(f.record)
  }
)

it.each(['lease', 'ownerGeneration', 'clientGeneration', 'clientInstanceId', 'resumed'])(
  'refuses authenticated session %s mismatch',
  (kind) => {
    const f = fixture()
    if (kind === 'lease') {
      f.session.owner.ownerLease = 'other'
    }
    if (kind === 'ownerGeneration') {
      f.session.owner.ownerGeneration++
    }
    if (kind === 'clientGeneration') {
      f.session.owner.clientGeneration++
    }
    if (kind === 'clientInstanceId') {
      f.session.owner.clientInstanceId = 'other'
    }
    if (kind === 'resumed') {
      f.session.resumed = false
    }
    expect(f.bind).toThrow()
  }
)

it.each(['recovery', 'leases', 'session', 'runtime', 'cancellation', 'authority'])(
  'revokes retained %s evidence',
  (kind) => {
    const f = fixture()
    const bound = f.bind()
    if (kind === 'recovery') {
      f.state.sshPtyConsumerRecoveries = []
    }
    if (kind === 'leases') {
      f.state.sshRemotePtyLeases[0].updatedAt++
    }
    if (kind === 'session') {
      f.session.owner.ownerGeneration++
    }
    if (kind === 'runtime') {
      f.options.assertRuntimeAbsent.mockImplementation(() => {
        throw new Error('lost')
      })
    }
    if (kind === 'cancellation') {
      f.options.assertCancellation.mockImplementation(() => {
        throw new Error('lost')
      })
    }
    if (kind === 'authority') {
      f.options.assertAuthority.mockImplementation(() => {
        throw new Error('lost')
      })
    }
    expect(bound.assertCurrent).toThrow()
  }
)

it('refuses alternate bindings and source projections', () => {
  const f = fixture()
  const bound = f.bind()
  expect(() => bound.assertBindings([])).toThrow('bindings_changed')
  expect(() =>
    bound.projectSourceState(
      f.state,
      {
        ...f.cutover.manifest.source,
        sshTargetId: 'other'
      },
      f.cutover.manifest.payload
    )
  ).toThrow('source_changed')
})

it('requires owner recovery and a strictly newer resumed generation', () => {
  const f = fixture()
  f.owner.ownerGeneration = 1
  expect(f.bind).toThrow('owner_required')
  f.state.sshPtyConsumerRecoveries = []
  expect(f.bind).toThrow('owner_required')
})

it('requires exact negotiated output flow control in saved recovery', () => {
  const f = fixture()
  f.owner.outputFlowControl = { version: 1, windowSu: 512 }
  expect(f.bind).toThrow('evidence_changed')
})

it('does not accept mutation of evidence inside runtime absence checks', () => {
  const f = fixture()
  const bound = f.bind()
  f.options.assertRuntimeAbsent.mockImplementation(() => {
    f.state.sshRemotePtyLeases[0].updatedAt++
  })
  expect(bound.assertCurrent).toThrow('evidence_changed')
})

it('keeps record and binding snapshots independent of caller mutation', () => {
  const f = fixture()
  const original = structuredClone(f.record)
  const bound = f.bind()
  Object.assign(f.record.release.cutover.liveTerminalBindings![0].identity, {
    terminalId: 'mutated'
  })
  bound.assertBindings(original.release.cutover.liveTerminalBindings)
  bound.assertCancellation(original)
  expect(f.options.assertCancellation).toHaveBeenLastCalledWith(original)
})

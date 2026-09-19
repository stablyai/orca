import { expect, it } from 'vitest'
import { createOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'
import { liveSourceRetirementFixture } from './orcad-live-source-retirement-test-fixture'
import { buildOrcadLiveSourceRetirementCandidate } from './orcad-live-source-retirement-candidate'
import { projectOrcadSourceLiveState } from './orcad-source-live-state-projection'
import { assertOrcadLiveSuccessorProfileChanges } from './orcad-live-successor-profile-changes'

function fixture(kind: 'folder' | 'worktree' = 'folder', unrelated = false) {
  const f = liveSourceRetirementFixture(kind)
  const bindings = f.cutover.liveTerminalBindings!
  if (unrelated) {
    f.state.sshRemotePtyLeases.push({
      ...f.state.sshRemotePtyLeases[0],
      targetId: 'other',
      ptyId: 'other-pty'
    })
    f.state.sshPtyConsumerRecoveries!.push({
      ...f.state.sshPtyConsumerRecoveries![0],
      targetId: 'other'
    })
  }
  const record = createOrcadLiveSourceRetirementRecord({
    state: f.state,
    sourceAdmission: f.sourceAdmission,
    release: {
      version: 1,
      cutover: f.cutover,
      activations: f.cutover.terminalPublications!.map((publication) => ({
        version: 1,
        identity: publication.identity,
        publicationReceipt: publication.publicationReceipt,
        destinationClaim: { generation: 1, claimId: 'claim' },
        catalog: publication.catalog
      }))
    }
  })
  const owner = {
    ...f.state.sshPtyConsumerRecoveries![0],
    clientGeneration: 2,
    ownerGeneration: 2,
    outputFlowControl: { version: 1 as const, windowSu: 256 }
  }
  f.state.sshPtyConsumerRecoveries = [
    ...f.state.sshPtyConsumerRecoveries!.filter((row) => row.targetId !== owner.targetId),
    owner
  ]
  const candidate = buildOrcadLiveSourceRetirementCandidate({
    state: f.state,
    cutover: f.cutover,
    sourceAdmission: {
      assertBindings: () => {},
      assertCurrent: () => {},
      projectSourceState: (state, source, catalog) =>
        projectOrcadSourceLiveState(state, source, catalog, {
          bindings,
          leases: f.state.sshRemotePtyLeases.filter((row) => row.targetId === owner.targetId),
          recovery: owner
        })
    }
  })
  const run = () =>
    assertOrcadLiveSuccessorProfileChanges({ state: f.state, candidate, record, owner })
  return { ...f, record, owner, candidate, run }
}

it.each(['folder', 'worktree'] as const)(
  'admits newer owner evidence for %s typed projection',
  (kind) => {
    const f = fixture(kind)
    const before = structuredClone({ state: f.state, candidate: f.candidate, record: f.record })
    expect(f.run).not.toThrow()
    expect({ state: f.state, candidate: f.candidate, record: f.record }).toEqual(before)
  }
)

it('allows target recovery upsert ordering while preserving unrelated rows', () => {
  const f = fixture('folder', true)
  expect(f.state.sshPtyConsumerRecoveries!.map((row) => row.targetId)).toEqual(['other', 'ssh-1'])
  expect(f.candidate.sshPtyConsumerRecoveries!.map((row) => row.targetId)).toEqual(['other'])
  expect(f.run).not.toThrow()
})

it.each(['attached', 'detached'] as const)('admits bounded %s lease timestamp updates', (state) => {
  const f = fixture()
  Object.assign(f.state.sshRemotePtyLeases[0], {
    state,
    updatedAt: 10,
    lastAttachedAt: 5,
    lastDetachedAt: 8
  })
  expect(f.run).not.toThrow()
})

it.each(['clientGeneration', 'ownerGeneration'] as const)('rejects equal or older %s', (field) => {
  for (const generation of [1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture()
    f.owner[field] = generation
    expect(f.run).toThrow('recovery_conflict')
  }
})

it.each(['clientInstanceId', 'serverBuildId', 'ownerLease'] as const)(
  'rejects changed %s',
  (field) => {
    const f = fixture()
    f.owner[field] = 'different'
    expect(f.run).toThrow('recovery_conflict')
  }
)

it('rejects a supplied owner different from persisted recovery', () => {
  const f = fixture()
  f.state.sshPtyConsumerRecoveries = [{ ...f.owner, ownerGeneration: 3 }]
  expect(f.run).toThrow('recovery_conflict')
})

it('rejects a supplied owner for another target', () => {
  const f = fixture()
  f.owner.targetId = 'other'
  expect(f.run).toThrow('target_conflict')
})

it.each([
  { pendingKill: { requestedAt: 2 } },
  { supersededBy: 'replacement' },
  { relayIdRecycled: true },
  { ptyId: 'replacement' },
  { worktreeId: 'replacement' },
  { tabId: 'replacement' },
  { leafId: 'replacement' },
  { createdAt: 2 },
  { state: 'expired' },
  { updatedAt: 0 },
  { updatedAt: 2, lastAttachedAt: 3 },
  { updatedAt: 2, lastDetachedAt: -1 }
])('rejects lease drift %j', (change) => {
  const f = fixture()
  Object.assign(f.state.sshRemotePtyLeases[0], change)
  expect(f.run).toThrow()
})

it('rejects removed or duplicated cohort lease identities', () => {
  const removed = fixture()
  removed.state.sshRemotePtyLeases.pop()
  expect(removed.run).toThrow('lease_conflict')
  const duplicate = fixture()
  duplicate.state.sshRemotePtyLeases[1] = structuredClone(duplicate.state.sshRemotePtyLeases[0])
  expect(duplicate.run).toThrow('lease_conflict')
})

it.each(['lease', 'recovery'] as const)('rejects unrelated %s changes', (kind) => {
  const f = fixture('folder', true)
  if (kind === 'lease') {
    f.state.sshRemotePtyLeases.find((row) => row.targetId === 'other')!.updatedAt = 20
  } else {
    f.state.sshPtyConsumerRecoveries!.find((row) => row.targetId === 'other')!.ownerGeneration++
  }
  expect(f.run).toThrow(`${kind}_conflict`)
})

it('rejects topology drift even when the candidate erases it', () => {
  const f = fixture()
  const layout = f.state.workspaceSessionsByHostId![f.hostId]!.terminalLayoutsByTabId['tab-1']
  layout.activeLeafId = f.cutover.liveTerminalBindings!.find(
    (binding) => binding.surfaceBinding.leafId !== layout.activeLeafId
  )!.surfaceBinding.leafId
  expect(f.run).toThrow('before_conflict')
})

it('rejects typed candidate after-state drift', () => {
  const f = fixture()
  f.candidate.folderWorkspaces = structuredClone(f.state.folderWorkspaces)
  expect(f.run).toThrow('candidate_conflict')
})

it('rejects changes outside the retirement field set', () => {
  const f = fixture()
  f.candidate.sshTargets[0].label = 'changed'
  expect(f.run).toThrow('scope_changed')
})

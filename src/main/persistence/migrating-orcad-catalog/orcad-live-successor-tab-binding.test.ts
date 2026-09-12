import { expect, it, vi } from 'vitest'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { createOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'
import { liveSourceRetirementFixture } from './orcad-live-source-retirement-test-fixture'
import { buildOrcadLiveSourceRetirementCandidate } from './orcad-live-source-retirement-candidate'
import { projectOrcadSourceLiveState } from './orcad-source-live-state-projection'
import { assertOrcadLiveSuccessorProfileChanges } from './orcad-live-successor-profile-changes'
import { assertOrcadLiveSuccessorTabBindingChange } from './orcad-live-successor-tab-binding'
import { PtyBindingPersistenceOperations } from '../loading-store/pty-binding-persistence'

function fixture(kind: 'folder' | 'worktree' = 'folder', local = false) {
  const f = liveSourceRetirementFixture(kind, 'ssh-1', local)
  const field: 'workspaceSession' | 'workspaceSessionsByHostId' = local
    ? 'workspaceSession'
    : 'workspaceSessionsByHostId'
  const before = serializeOrcadMigrationValue(f.state[field])
  const original = structuredClone(f.state)
  const session = local ? f.state.workspaceSession : f.state.workspaceSessionsByHostId![f.hostId]!
  const tab = Object.values(session.tabsByWorktree).flat()[0]
  const binding = f.cutover.liveTerminalBindings!.find(
    ({ identity }) => toAppSshPtyId('ssh-1', identity.terminalId) !== tab.ptyId
  )!
  tab.ptyId = toAppSshPtyId('ssh-1', binding.identity.terminalId)
  const run = () =>
    assertOrcadLiveSuccessorTabBindingChange(
      before,
      serializeOrcadMigrationValue(f.state[field]),
      field,
      f.cutover
    )
  return { ...f, field, before, original, session, tab, binding, run }
}

it.each(['folder', 'worktree'] as const)('admits the real %s reconnect binding writer', (kind) => {
  const f = fixture(kind, true)
  const state = structuredClone(f.original)
  const flushOrThrow = vi.fn()
  const sessions = {
    getWorkspaceSession: () => state.workspaceSession
  } as ConstructorParameters<typeof PtyBindingPersistenceOperations>[1]
  const writer = new PtyBindingPersistenceOperations({ state, flushOrThrow }, sessions)
  const { identity, surfaceBinding } = f.binding
  expect(
    writer.persistPtyBinding({
      worktreeId: f.tab.worktreeId,
      tabId: surfaceBinding.tabId,
      leafId: surfaceBinding.leafId,
      ptyId: toAppSshPtyId('ssh-1', identity.terminalId),
      incarnationId: identity.incarnationId,
      mayReviveRetiredSurface: false
    })
  ).toBe(true)
  expect(flushOrThrow).toHaveBeenCalledOnce()
  expect(Object.values(state.workspaceSession.tabsByWorktree).flat()[0].ptyId).toBe(f.tab.ptyId)
  expect(() =>
    assertOrcadLiveSuccessorTabBindingChange(
      f.before,
      serializeOrcadMigrationValue(state.workspaceSession),
      'workspaceSession',
      f.cutover
    )
  ).not.toThrow()
})

it.each([
  ['folder', false],
  ['worktree', false],
  ['folder', true],
  ['worktree', true]
] as const)(
  'accepts %s split-tab pointer change (local=%s) without changing JSON',
  (kind, local) => {
    const f = fixture(kind, local)
    const snapshot = serializeOrcadMigrationValue(f.state)
    const saved = f.before
    expect(f.run).not.toThrow()
    expect(serializeOrcadMigrationValue(f.state)).toBe(snapshot)
    expect(f.before).toBe(saved)
  }
)

it.each(['ssh:other:pty', 'unknown-pty', null])('rejects unbound tab pointer %s', (pty) => {
  const f = fixture()
  f.tab.ptyId = pty
  expect(f.run).toThrow()
})

it('rejects an absent tab pointer', () => {
  const f = fixture()
  Reflect.deleteProperty(f.tab, 'ptyId')
  expect(f.run).toThrow()
})

it('rejects a missing tab', () => {
  const f = fixture()
  for (const key of Object.keys(f.session.tabsByWorktree)) {
    f.session.tabsByWorktree[key] = []
  }
  expect(f.run).toThrow()
})

it('rejects duplicate tab identity', () => {
  const f = fixture()
  Object.values(f.session.tabsByWorktree)[0].push(structuredClone(f.tab))
  expect(f.run).toThrow()
})

it('rejects a changed tab identity', () => {
  const f = fixture()
  f.tab.id = 'different-tab'
  expect(f.run).toThrow()
})

it('rejects changed pane-to-PTY mapping', () => {
  const f = fixture()
  f.session.terminalLayoutsByTabId[f.tab.id].ptyIdsByLeafId![f.binding.surfaceBinding.leafId] =
    'wrong'
  expect(f.run).toThrow()
})

it('rejects changed leaf layout', () => {
  const f = fixture()
  f.session.terminalLayoutsByTabId[f.tab.id].root = { type: 'leaf', leafId: 'wrong' }
  expect(f.run).toThrow()
})

it('rejects changed incarnation', () => {
  const f = fixture()
  f.session.terminalPtyIncarnationsByPaneKey![`${f.tab.id}:${f.binding.surfaceBinding.leafId}`] =
    'wrong'
  expect(f.run).toThrow()
})

it('rejects tombstoned pane', () => {
  const f = fixture()
  Object.assign(f.session, {
    terminalSurfaceTombstonesByPaneKey: { [`${f.tab.id}:${f.binding.surfaceBinding.leafId}`]: {} }
  })
  expect(f.run).toThrow()
})

it('rejects metadata drift accompanying pointer change', () => {
  const f = fixture()
  f.tab.title = 'changed'
  expect(f.run).toThrow()
})

it('rejects pointer changes in an unrelated host partition', () => {
  const f = fixture()
  const previous = { 'ssh:other': f.original.workspaceSessionsByHostId![f.hostId] }
  const current = { 'ssh:other': f.session }
  expect(() =>
    assertOrcadLiveSuccessorTabBindingChange(
      serializeOrcadMigrationValue(previous),
      serializeOrcadMigrationValue(current),
      'workspaceSessionsByHostId',
      f.cutover
    )
  ).toThrow()
})

it('rejects unrelated host metadata drift', () => {
  const f = fixture()
  f.state.workspaceSessionsByHostId!['ssh:other'] = structuredClone(f.session)
  expect(f.run).toThrow()
})

it('rejects missing before/after partitions', () => {
  const f = fixture()
  expect(() =>
    assertOrcadLiveSuccessorTabBindingChange(null, f.before, f.field, f.cutover)
  ).toThrow()
  expect(() =>
    assertOrcadLiveSuccessorTabBindingChange(f.before, null, f.field, f.cutover)
  ).toThrow()
})

it.each(['folder', 'worktree'] as const)(
  'admits %s pointer change through the full profile predicate',
  (kind) => {
    const f = fixture(kind)
    const record = createOrcadLiveSourceRetirementRecord({
      state: f.original,
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
      ownerGeneration: 2
    }
    f.state.sshPtyConsumerRecoveries = [owner]
    const candidate = buildOrcadLiveSourceRetirementCandidate({
      state: f.state,
      cutover: f.cutover,
      sourceAdmission: {
        assertBindings: () => {},
        assertCurrent: () => {},
        projectSourceState: (state, source, catalog) =>
          projectOrcadSourceLiveState(state, source, catalog, {
            bindings: f.cutover.liveTerminalBindings!,
            leases: f.state.sshRemotePtyLeases,
            recovery: owner
          })
      }
    })
    expect(() =>
      assertOrcadLiveSuccessorProfileChanges({ state: f.state, candidate, record, owner })
    ).not.toThrow()
  }
)

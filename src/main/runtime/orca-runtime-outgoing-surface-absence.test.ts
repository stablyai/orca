import { expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

const target = 'source'
const id = toAppSshPtyId(target, 'pty')
const leafId = '11111111-1111-4111-8111-111111111111'
const surfaces = [
  {
    ptyId: id,
    surfaceBinding: {
      executionHostId: 'local',
      workspaceKey: 'folder:source',
      tabId: 'tab',
      leafId,
      ptyId: 'pty'
    }
  }
]

class Runtime extends OrcaRuntimeService {
  indexes(): Record<string, Map<string, unknown>> {
    return {
      ptys: this.ptysById,
      models: this.headlessTerminals,
      hydration: this.headlessHydrationState,
      sequences: this.ptyOutputSequenceById,
      titleTrackers: this.ptyTitleTrackersByPtyId,
      waitChecks: this.waitBlockedCheckStateByPtyId,
      handles: this.handleByPtyId,
      incarnations: this.handleByPtyIncarnation,
      leafIndex: this.leavesByPtyId,
      detached: this.detachedPreAllocatedLeaves,
      registration: this.pendingPtyRegistrationIncarnations,
      replacement: this.pendingPtyHandleReplacementFences,
      sends: this.terminalSendOperationsByPtyId,
      sendsInFlight: this.terminalSendOperationsInFlightByPtyId
    }
  }
  seedAlias() {
    this.handleByLeafKey.set(this.getLeafKey('tab', leafId), 'orphan-handle')
  }
  seedOrphanHandle() {
    this.handles.set('orphan', {
      handle: 'orphan',
      runtimeId: this.getRuntimeId(),
      rendererGraphEpoch: 1,
      worktreeId: 'folder:source',
      tabId: 'tab',
      leafId,
      ptyId: null,
      ptyGeneration: 1
    })
  }
  seedSnapshot(parentOnly: boolean) {
    this.storeMobileSessionSnapshot('folder:source', {
      worktree: 'folder:source',
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [
        {
          type: 'terminal',
          id: `tab::${leafId}`,
          parentTabId: 'tab',
          leafId,
          ptyId: parentOnly ? null : id,
          title: 'source',
          isActive: false
        }
      ]
    })
  }
}

function fixture() {
  const runtime = new Runtime()
  fenceOutgoingPtyRegistrations(runtime, [id])
  return { runtime, bind: () => runtime.bindOutgoingSshPtySurfaceAbsence(target, surfaces) }
}

it('binds fresh local surface absence only after admission fencing and keeps source registration refused', () => {
  const runtime = new Runtime()
  expect(() => runtime.bindOutgoingSshPtySurfaceAbsence(target, surfaces)).toThrow(
    'admission_unfenced'
  )
  fenceOutgoingPtyRegistrations(runtime, [id])
  const bound = runtime.bindOutgoingSshPtySurfaceAbsence(target, surfaces)
  expect(() => bound.assertAbsent()).not.toThrow()
  expect(() => runtime.registerPty(id, 'folder:source', target, { tabId: 'tab', leafId })).toThrow(
    'registration_fenced'
  )
})

it.each([
  'ptys',
  'models',
  'hydration',
  'sequences',
  'titleTrackers',
  'waitChecks',
  'handles',
  'incarnations',
  'leafIndex',
  'detached',
  'registration',
  'replacement',
  'sends',
  'sendsInFlight'
])('refuses residual source %s state even when other source objects are missing', (kind) => {
  const f = fixture()
  const bound = f.bind()
  f.runtime.indexes()[kind].set(id, undefined)
  expect(() => bound.assertAbsent()).toThrow('surfaces_present')
  expect(() => f.bind()).toThrow('surfaces_present')
})

it('refuses unexpected terminal state on the same source target, without touching other targets', () => {
  const f = fixture()
  f.runtime.indexes().sequences.set(toAppSshPtyId('other', 'pty'), 10)
  expect(() => f.bind()).not.toThrow()
  f.runtime.indexes().sequences.set(toAppSshPtyId(target, 'unexpected'), 10)
  expect(() => f.bind()).toThrow('surfaces_present')
  expect(f.runtime.indexes().sequences.size).toBe(2)
})

it('refuses a source leaf alias without any corresponding leaf or handle record', () => {
  const f = fixture()
  f.runtime.seedAlias()
  expect(() => f.bind()).toThrow('surfaces_present')
})

it('refuses a handle still bound to the source surface even without a PTY identity', () => {
  const f = fixture()
  f.runtime.seedOrphanHandle()
  expect(() => f.bind()).toThrow('surfaces_present')
})

it.each([false, true])(
  'refuses source mobile surfaces including a parent-only shell (%s)',
  (parentOnly) => {
    const runtime = new Runtime()
    runtime.seedSnapshot(parentOnly)
    fenceOutgoingPtyRegistrations(runtime, [id])
    expect(() => runtime.bindOutgoingSshPtySurfaceAbsence(target, surfaces)).toThrow(
      'surfaces_present'
    )
  }
)

it('refuses empty, duplicate, foreign and mismatched cohorts', () => {
  const f = fixture()
  expect(() => f.runtime.bindOutgoingSshPtySurfaceAbsence(target, [])).toThrow('cohort_invalid')
  expect(() =>
    f.runtime.bindOutgoingSshPtySurfaceAbsence(target, [...surfaces, ...surfaces])
  ).toThrow('cohort_invalid')
  expect(() => f.runtime.bindOutgoingSshPtySurfaceAbsence('other', surfaces)).toThrow(
    'cohort_invalid'
  )
  expect(() =>
    f.runtime.bindOutgoingSshPtySurfaceAbsence(target, [
      {
        ...surfaces[0],
        surfaceBinding: { ...surfaces[0].surfaceBinding, ptyId: 'replacement' }
      }
    ])
  ).toThrow('cohort_invalid')
})

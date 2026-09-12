import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import {
  createOrcadLiveAppliedCoverageEvidence,
  OrcadLiveAppliedCoverageEvidenceStore
} from './orcad-live-applied-coverage-evidence'
import {
  createOrcadLiveSuccessorCompletionPreparation,
  createOrcadLiveSuccessorRouteCheckpoint,
  OrcadLiveSuccessorCompletionPreparationStore,
  OrcadLiveSuccessorRouteCheckpointStore,
  readOrcadLiveSuccessorCompletionEvidence
} from './orcad-live-successor-completion-records'
import { createOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'
import {
  withOrcadCommittedProfileAuthority,
  withOrcadCommittedSuccessorProfileAuthority
} from './orcad-committed-profile-authority'
import type { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'

const mocked = vi.hoisted(() => ({
  inspect: vi.fn(),
  original: vi.fn(),
  successor: vi.fn(),
  native: vi.fn()
}))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: mocked.inspect
}))
vi.mock('./orcad-outgoing-authority', () => ({
  withOutgoingOrcadAuthority: mocked.original,
  withOutgoingOrcadSuccessorAuthority: mocked.successor
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-completion-authority-version-'))
  vi.resetAllMocks()
  const admit = async (...[, args, operation]: Parameters<typeof withOutgoingOrcadAuthority>) => {
    const assertAuthority = () => {
      mocked.native()
      args.assertEvidence()
    }
    assertAuthority()
    return operation({ assertAuthority, assertSourceCutoverOwner: vi.fn(), pairingCode: 'modeled' })
  }
  mocked.original.mockImplementation(admit)
  mocked.successor.mockImplementation(admit)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceCompletionEvidenceFixture(root, 'folder')
  f.persist()
  new OrcadLiveAppliedCoverageEvidenceStore(root).persist(
    createOrcadLiveAppliedCoverageEvidence({
      profileDirectory: root,
      record: f.record,
      coverages: []
    })
  )
  const preparation = createOrcadLiveSuccessorCompletionPreparation(root, f.record)
  new OrcadLiveSuccessorCompletionPreparationStore(root).persist(preparation)
  new OrcadLiveSuccessorRouteCheckpointStore(root).persist(
    createOrcadLiveSuccessorRouteCheckpoint(preparation)
  )
  const evidence = {
    original: readOrcadLiveSourceCompletionEvidence(root, f.committed),
    successor: readOrcadLiveSuccessorCompletionEvidence(root, f.record)
  }
  const completed = (mode: 'original' | 'successor') =>
    createOrcadLiveCompletedCutover({
      committed: f.committed,
      completionEvidence: evidence[mode],
      retiredAt: '2026-09-07T12:00:00.000Z'
    })
  const entry: { intent: OrcadMigrationSourceCutover; journal: OrcadMigrationSourceCutover } = {
    intent: f.committed,
    journal: f.committed
  }
  mocked.inspect.mockImplementation(() => [entry])
  const options = {
    profileDirectory: root,
    store: {} as never,
    migrationId: f.committed.manifest.migrationId,
    signal: new AbortController().signal
  }
  return { ...f, entry, options, completed }
}
const wrapper = (mode: 'original' | 'successor') =>
  mode === 'original'
    ? withOrcadCommittedProfileAuthority
    : withOrcadCommittedSuccessorProfileAuthority

it.each(['original', 'successor'] as const)(
  'requires explicit completed opt-in for %s authority',
  async (mode) => {
    const f = fixture()
    f.entry.journal = f.completed(mode)
    const operation = vi.fn()
    await expect(wrapper(mode)(f.options, operation)).rejects.toThrow('commit_required')
    expect(operation).not.toHaveBeenCalled()
    expect(mocked[mode]).not.toHaveBeenCalled()
  }
)

it.each(['original', 'successor'] as const)(
  'admits only matching completed version under %s authority',
  async (mode) => {
    const f = fixture()
    f.entry.journal = f.completed(mode)
    await expect(
      wrapper(mode)({ ...f.options, allowCompleted: true }, async (context) => {
        context.assertAuthority()
        expect(context.cutover).toEqual(f.committed)
        return 'admitted'
      })
    ).resolves.toBe('admitted')
    expect(mocked[mode]).toHaveBeenCalledOnce()
  }
)

it.each(['original', 'successor'] as const)(
  'refuses other completed version before entering %s authority',
  async (mode) => {
    const f = fixture()
    f.entry.journal = f.completed(mode === 'original' ? 'successor' : 'original')
    const operation = vi.fn()
    await expect(wrapper(mode)({ ...f.options, allowCompleted: true }, operation)).rejects.toThrow(
      'completion_authority_version_mismatch'
    )
    expect(operation).not.toHaveBeenCalled()
    expect(mocked[mode]).not.toHaveBeenCalled()
  }
)

it.each(['original', 'successor'] as const)(
  'transitions using the %s evidence chain despite both chains existing',
  async (mode) => {
    const f = fixture()
    const candidate = f.completed(mode)
    const write = vi.fn(() => {
      f.entry.journal = candidate
    })
    await wrapper(mode)({ ...f.options, allowCompleted: true }, async (context) => {
      context.transitionCompletedJournal(candidate, write)
      context.assertAuthority()
    })
    expect(write).toHaveBeenCalledOnce()
  }
)

it.each(['original', 'successor'] as const)(
  'refuses a transition carrying the other evidence version under %s authority',
  async (mode) => {
    const f = fixture()
    const write = vi.fn()
    await wrapper(mode)({ ...f.options, allowCompleted: true }, async (context) => {
      expect(() =>
        context.transitionCompletedJournal(
          f.completed(mode === 'original' ? 'successor' : 'original'),
          write
        )
      ).toThrow()
    })
    expect(write).not.toHaveBeenCalled()
  }
)

it.each(['original', 'successor'] as const)(
  'refuses transitions without completed opt-in under %s authority',
  async (mode) => {
    const f = fixture()
    const write = vi.fn()
    await wrapper(mode)(f.options, async (context) => {
      expect(() => context.transitionCompletedJournal(f.completed(mode), write)).toThrow(
        'transition_not_enabled'
      )
    })
    expect(write).not.toHaveBeenCalled()
  }
)

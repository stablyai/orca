import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'
import {
  createOrcadLiveAppliedCoverageEvidence,
  OrcadLiveAppliedCoverageEvidenceStore
} from './orcad-live-applied-coverage-evidence'
import { withOrcadLiveSuccessorReadiness } from './orcad-live-successor-readiness'

const m = vi.hoisted(() => ({
  cutover: undefined as unknown,
  native: vi.fn(),
  controls: vi.fn(),
  runtime: vi.fn(),
  commit: vi.fn(),
  activation: vi.fn(),
  transition: vi.fn(),
  admission: vi.fn(),
  bindControls: vi.fn()
}))
vi.mock('./orcad-committed-profile-authority', () => ({
  withOrcadCommittedSuccessorProfileAuthority: (
    options: unknown,
    operation: (context: unknown) => unknown
  ) => {
    m.admission(options)
    return operation({
      cutover: m.cutover,
      intent: m.cutover,
      pairingCode: 'pair',
      assertAuthority: m.native,
      transitionCompletedJournal: m.transition
    })
  }
}))
vi.mock('./orcad-live-successor-control-absence', () => ({
  bindOrcadLiveSuccessorControlAbsence: (...args: unknown[]) => {
    m.bindControls(...args)
    return { assertAbsent: m.controls }
  }
}))
vi.mock('./orcad-live-cleanup-destination-authority', () => ({
  reconfirmOrcadLiveCleanupDestination: m.commit
}))
vi.mock('./orcad-live-destination-activation', () => ({
  inspectOrcadLiveCatalogActivationCohort: m.activation
}))

let root: string
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'orca-successor-readiness-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture(mixed = false) {
  const ordinary = mixed ? undefined : liveSourceCompletionEvidenceFixture(root, 'folder')
  const covered = mixed ? appliedCoverageFixture(root) : undefined
  ordinary?.persist()
  const record = covered?.record ?? ordinary!.record
  const f = { record, committed: record.release.cutover }
  const applied = covered
    ? covered.create()
    : createOrcadLiveAppliedCoverageEvidence({
        profileDirectory: root,
        record: f.record,
        coverages: []
      })
  new OrcadLiveAppliedCoverageEvidenceStore(root).persist(applied)
  m.cutover = f.committed
  m.activation.mockResolvedValue({
    cutover: f.committed,
    activations: f.record.release.activations
  })
  const controller = new AbortController()
  const profile = vi.fn(() => ({ state: 'profile-installed' }))
  const runtime = { bindOutgoingSshPtySurfaceAbsence: vi.fn(() => ({ assertAbsent: m.runtime })) }
  const options = {
    profileDirectory: root,
    migrationId: f.committed.manifest.migrationId,
    signal: controller.signal,
    runtime,
    store: {
      getSshTarget: vi.fn(),
      listOrcadMigrationSourceCutovers: vi.fn(),
      inspectOrcadLiveRetirementProfileState: profile
    }
  } as unknown as Parameters<typeof withOrcadLiveSuccessorReadiness>[0]
  return {
    ...f,
    applied,
    controller,
    profile,
    runtime,
    options,
    run: <T>(operation: Parameters<typeof withOrcadLiveSuccessorReadiness<T>>[1]) =>
      withOrcadLiveSuccessorReadiness(options, operation)
  }
}

it('joins actual durable evidence and scopes readiness to the native authority callback', async () => {
  const f = fixture()
  let retained!: () => void
  const result = await f.run(async (context) => {
    context.assertCurrent()
    retained = context.assertCurrent
    expect(context.record).toEqual(f.record)
    expect(context.receipts).toHaveLength(f.committed.liveTerminalBindings!.length)
    expect(context.appliedEvidence).toEqual(f.applied)
    return 'ready'
  })
  expect(result).toBe('ready')
  expect(m.commit).toHaveBeenCalledOnce()
  expect(m.activation).toHaveBeenCalledOnce()
  expect(f.runtime.bindOutgoingSshPtySurfaceAbsence).toHaveBeenCalledOnce()
  expect(() => retained()).toThrow('readiness_released')
})

it('forwards explicit completed admission and guards transitions before and after writing', async () => {
  const f = fixture()
  f.options.allowCompleted = true
  const candidate = { phase: 'modeled-completion' }
  const write = vi.fn()
  let retained!: (candidate: unknown, write: () => void) => void
  m.transition.mockImplementation((_candidate, operation) => operation())
  await f.run(async (context) => {
    retained = context.transitionCompletedJournal
    context.transitionCompletedJournal(candidate, write)
    expect(m.transition).toHaveBeenCalledWith(candidate, write)
  })
  expect(m.admission).toHaveBeenCalledWith(expect.objectContaining({ allowCompleted: true }))
  expect(write).toHaveBeenCalledOnce()
  expect(() => retained(candidate, write)).toThrow('readiness_released')
  expect(write).toHaveBeenCalledOnce()
})

it.each(['before', 'after'] as const)(
  'refuses readiness loss %s a completion transition',
  async (when) => {
    const f = fixture()
    const write = vi.fn()
    m.transition.mockImplementation((_candidate, operation) => {
      operation()
      f.profile.mockReturnValue({ state: 'conflict' })
    })
    await expect(
      f.run(async (context) => {
        if (when === 'before') {
          f.profile.mockReturnValue({ state: 'conflict' })
        }
        context.transitionCompletedJournal({}, write)
      })
    ).rejects.toThrow('profile_changed')
    expect(write).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
  }
)

it('admits mixed cancellation versions only with retained covered-output dependencies', async () => {
  const f = fixture(true)
  await f.run(async ({ receipts, appliedEvidence }) => {
    expect(receipts.map((receipt) => receipt.version).sort()).toEqual([1, 2])
    expect(appliedEvidence.coverages).toHaveLength(1)
  })
})

it('refuses a covered member whose durable capture disappears', async () => {
  const f = fixture(true)
  const key = createHash('sha256').update(f.record.identity.bridgeId).digest('hex')
  unlinkSync(join(root, 'orcad-outgoing-captures', `${key}.json`))
  const operation = vi.fn()
  await expect(f.run(operation)).rejects.toThrow()
  expect(operation).not.toHaveBeenCalled()
})

it.each(['controls', 'runtime', 'native'] as const)(
  'refuses changed %s while destination inspection yields',
  async (kind) => {
    const f = fixture()
    m.commit.mockImplementation(async () => {
      m[kind].mockImplementation(() => {
        throw new Error('changed')
      })
    })
    const work = vi.fn()
    await expect(f.run(work)).rejects.toThrow('changed')
    expect(work).not.toHaveBeenCalled()
  }
)

it.each(['conflict', 'profile-not-installed'])(
  'refuses %s before inspecting the destination',
  async (state) => {
    const f = fixture()
    f.profile.mockReturnValue({ state })
    await expect(f.run(vi.fn())).rejects.toThrow('profile_changed')
    expect(m.commit).not.toHaveBeenCalled()
  }
)

it('rechecks authority and profile after the protected operation', async () => {
  const f = fixture()
  await expect(
    f.run(async () => {
      f.profile.mockReturnValue({ state: 'conflict' })
    })
  ).rejects.toThrow('profile_changed')
})

it('refuses cancellation during a protected operation', async () => {
  const f = fixture()
  await expect(
    f.run(async () => {
      f.controller.abort()
    })
  ).rejects.toThrow()
})

it('invalidates retained authority after an operation throws', async () => {
  const f = fixture()
  let retained!: () => void
  await expect(
    f.run(async ({ assertCurrent }) => {
      retained = assertCurrent
      throw new Error('operation-failed')
    })
  ).rejects.toThrow('operation-failed')
  expect(() => retained()).toThrow('readiness_released')
})

it.each([
  'orcad-live-applied-coverage-evidence',
  'orcad-live-source-retirement-records',
  'orcad-live-source-cancellation-receipts'
])('refuses a missing %s record before running the protected operation', async (directory) => {
  const f = fixture()
  const key = createHash('sha256').update(f.record.identity.bridgeId).digest('hex')
  unlinkSync(join(root, directory, `${key}.json`))
  const operation = vi.fn()
  await expect(f.run(operation)).rejects.toThrow()
  expect(operation).not.toHaveBeenCalled()
  expect(m.commit).not.toHaveBeenCalled()
})

it('rejects durable evidence disappearing while destination inspection yields', async () => {
  const f = fixture()
  m.commit.mockImplementation(async () => {
    const key = createHash('sha256').update(f.record.identity.bridgeId).digest('hex')
    unlinkSync(join(root, 'orcad-live-applied-coverage-evidence', `${key}.json`))
  })
  const operation = vi.fn()
  await expect(f.run(operation)).rejects.toThrow('evidence_required')
  expect(operation).not.toHaveBeenCalled()
  expect(m.activation).not.toHaveBeenCalled()
})

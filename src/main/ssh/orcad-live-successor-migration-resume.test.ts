import { beforeEach, expect, it, vi } from 'vitest'
import { resumeOrcadLiveSuccessorMigration } from './orcad-live-successor-migration-resume'

const steps = vi.hoisted(() => ({
  cutover: vi.fn(),
  retirement: vi.fn(),
  select: vi.fn(),
  authority: vi.fn(),
  cohort: vi.fn(),
  cancellation: vi.fn(),
  deliveries: vi.fn(),
  profile: vi.fn(),
  prepare: vi.fn(),
  complete: vi.fn()
}))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: steps.cutover
}))
vi.mock('./orcad-live-retirement-recovery-inspection', () => ({
  inspectOrcadLiveRetirementRecovery: steps.retirement
}))
vi.mock('./orcad-live-resume-authority-selection', () => ({
  selectOrcadLiveResumeAuthority: steps.select
}))
vi.mock('./orcad-live-cancellation-cohort', () => ({
  bindOrcadLiveCancellationCohort: steps.cohort
}))
vi.mock('./orcad-live-successor-source-retirement', () => ({
  retireOrcadLiveSuccessorSourceDeliveries: steps.deliveries
}))
vi.mock('./orcad-live-successor-profile-installation', () => ({
  installOrcadLiveSuccessorSourceProfile: steps.profile
}))
vi.mock('./orcad-live-successor-route-preparation', () => ({
  prepareOrcadLiveSuccessorCompletion: steps.prepare
}))
vi.mock('./orcad-live-successor-migration-completion', () => ({
  completeOrcadLiveSuccessorMigration: steps.complete
}))

const manifest = { migrationId: 'migration' }
const record = { release: { cutover: { manifest } } }
beforeEach(() => {
  vi.resetAllMocks()
  steps.cutover.mockReturnValue([
    { intent: { manifest }, journal: { phase: 'destination-committed' } }
  ])
  steps.retirement.mockReturnValue([{ state: 'prepared', record }])
  steps.select.mockReturnValue({ mode: 'successor', assertCurrent: steps.authority })
  steps.cohort.mockReturnValue({ assertCancellation: steps.cancellation })
  steps.deliveries.mockResolvedValue({ phase: 'source-deliveries-retired' })
  steps.profile.mockResolvedValue({ marker: 'installed' })
  steps.prepare.mockResolvedValue({ preparation: { version: 2 }, checkpoint: { phase: 'refused' } })
  steps.complete.mockResolvedValue({
    phase: 'source-retired',
    sourceRetirement: 'complete',
    receipts: ['covered']
  })
})
function run(signal = new AbortController().signal, recoveryOnly?: boolean) {
  return resumeOrcadLiveSuccessorMigration({
    profileDirectory: 'profile',
    migrationId: 'migration',
    signal,
    recoveryOnly
  } as Parameters<typeof resumeOrcadLiveSuccessorMigration>[0])
}

it('retires source delivery before profile, preparation and durable completion', async () => {
  const result = await run()
  const order = [steps.deliveries, steps.profile, steps.prepare, steps.complete].map(
    (step) => step.mock.invocationCallOrder[0]
  )
  expect(order).toEqual([...order].sort((a, b) => a - b))
  for (const step of [steps.deliveries, steps.profile, steps.prepare, steps.complete]) {
    expect(step).toHaveBeenCalledOnce()
  }
  expect(result).toEqual({
    phase: 'source-retired',
    sourceRetirement: 'complete',
    receipts: ['covered'],
    completionPreparation: { version: 2 },
    routeCheckpoint: { phase: 'refused' }
  })
})

it('never resumes source delivery after profile installation and requires the saved cancellation cohort', async () => {
  steps.retirement.mockReturnValue([{ state: 'profile-installed', record }])
  await run()
  expect(steps.deliveries).not.toHaveBeenCalled()
  expect(steps.cohort).toHaveBeenCalledWith('profile', record)
  expect(steps.cancellation).toHaveBeenCalledWith(record)
  expect(steps.cancellation.mock.invocationCallOrder[0]).toBeLessThan(
    steps.profile.mock.invocationCallOrder[0]
  )
})

it('does not repair missing installed-profile cancellation by reopening source ownership', async () => {
  steps.retirement.mockReturnValue([{ state: 'profile-installed', record }])
  steps.cancellation.mockImplementation(() => {
    throw new Error('cohort-missing')
  })
  await expect(run()).rejects.toThrow('cohort-missing')
  expect(steps.deliveries).not.toHaveBeenCalled()
  expect(steps.profile).not.toHaveBeenCalled()
  expect(steps.complete).not.toHaveBeenCalled()
})

it.each(['selection', 'current', 'original'])(
  'refuses %s authority without entering any migration stage',
  async (kind) => {
    if (kind === 'selection') {
      steps.select.mockImplementation(() => {
        throw new Error('native-refused')
      })
    } else if (kind === 'current') {
      steps.authority.mockImplementation(() => {
        throw new Error('native-refused')
      })
    } else {
      steps.select.mockReturnValue({ mode: 'original', assertCurrent: steps.authority })
    }
    await expect(run()).rejects.toThrow()
    expect(steps.deliveries).not.toHaveBeenCalled()
    expect(steps.profile).not.toHaveBeenCalled()
  }
)

it.each(['missing', 'conflict'])(
  'requires a nonconflicting retirement record: %s',
  async (kind) => {
    steps.retirement.mockReturnValue(kind === 'missing' ? [] : [{ state: 'conflict', record }])
    await expect(run()).rejects.toThrow('retirement_record_required')
    expect(steps.deliveries).not.toHaveBeenCalled()
    expect(steps.profile).not.toHaveBeenCalled()
  }
)

it.each(['destination-staged', 'source-fenced', 'source-retired', 'missing'])(
  'refuses unsupported observed phase %s',
  async (phase) => {
    steps.cutover.mockReturnValue(
      phase === 'missing' ? [] : [{ intent: { manifest }, journal: { phase } }]
    )
    await expect(run()).rejects.toThrow('commit_required')
    expect(steps.select).not.toHaveBeenCalled()
    expect(steps.deliveries).not.toHaveBeenCalled()
  }
)

it.each(['deliveries', 'profile', 'prepare'] as const)('stops on abort after %s', async (stage) => {
  const controller = new AbortController()
  steps[stage].mockImplementation(async () => {
    controller.abort(new Error('stopped'))
    return { preparation: {}, checkpoint: {} }
  })
  await expect(run(controller.signal)).rejects.toThrow('stopped')
  const next =
    stage === 'deliveries' ? steps.profile : stage === 'profile' ? steps.prepare : steps.complete
  expect(next).not.toHaveBeenCalled()
})

it.each(['deliveries', 'profile', 'prepare', 'complete'] as const)(
  'propagates %s failure without retry or fallback',
  async (stage) => {
    steps[stage].mockRejectedValue(new Error('stage-refused'))
    await expect(run()).rejects.toThrow('stage-refused')
    expect(steps[stage]).toHaveBeenCalledOnce()
    expect(steps.select).toHaveBeenCalledOnce()
  }
)

it.each([undefined, false, true])('preserves recoveryOnly=%s', async (recoveryOnly) => {
  await run(undefined, recoveryOnly)
  expect(steps.deliveries).toHaveBeenCalledWith(
    expect.objectContaining({ recoveryOnly: recoveryOnly ?? false })
  )
})

it('rechecks successor authority after awaited profile installation', async () => {
  steps.profile.mockImplementation(async () => {
    steps.authority.mockImplementation(() => {
      throw new Error('successor-revoked')
    })
  })
  await expect(run()).rejects.toThrow('successor-revoked')
  expect(steps.prepare).not.toHaveBeenCalled()
  expect(steps.complete).not.toHaveBeenCalled()
})

it('does not return success when cancellation arrives during completion', async () => {
  const controller = new AbortController()
  steps.complete.mockImplementation(async () => {
    controller.abort(new Error('final-abort'))
    return { phase: 'source-retired', sourceRetirement: 'complete' }
  })
  await expect(run(controller.signal)).rejects.toThrow('final-abort')
})

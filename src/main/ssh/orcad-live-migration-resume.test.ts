import { beforeEach, expect, it, vi } from 'vitest'
import { resumeOrcadLiveMigration } from './orcad-live-migration-resume'

const steps = vi.hoisted(() => ({
  destination: vi.fn(),
  profile: vi.fn(),
  cleanup: vi.fn(),
  reflush: vi.fn(),
  deliveries: vi.fn(),
  completion: vi.fn(),
  routes: vi.fn(),
  finalize: vi.fn(),
  successorFinalize: vi.fn(),
  selectAuthority: vi.fn(),
  assertAuthority: vi.fn(),
  successorResume: vi.fn(),
  retirement: vi.fn(),
  cutover: vi.fn()
}))
vi.mock('./orcad-live-destination-coordinator', () => ({
  resumeOrcadLiveDestination: steps.destination
}))
vi.mock('./orcad-live-source-profile-installation', () => ({
  installOrcadLiveSourceProfile: steps.profile
}))
vi.mock('./orcad-live-source-runtime-cleanup', () => ({
  cleanupOrcadLiveSourceRuntime: steps.cleanup
}))
vi.mock('./orcad-live-runtime-cleanup-resume', () => ({
  reflushOrcadLiveRuntimeCleanupCheckpoint: steps.reflush
}))
vi.mock('./orcad-live-source-delivery-retirement', () => ({
  retireOrcadLiveSourceDeliveries: steps.deliveries
}))
vi.mock('./orcad-live-source-completion', () => ({
  prepareOrcadLiveSourceCompletion: steps.completion
}))
vi.mock('./orcad-live-source-route-retirement', () => ({
  retireOrcadLiveSourceRoutes: steps.routes
}))
vi.mock('./orcad-live-migration-completion', () => ({
  completeOrcadLiveMigration: steps.finalize
}))
vi.mock('./orcad-live-successor-migration-completion', () => ({
  completeOrcadLiveSuccessorMigration: steps.successorFinalize
}))
vi.mock('./orcad-live-resume-authority-selection', () => ({
  selectOrcadLiveResumeAuthority: steps.selectAuthority
}))
vi.mock('./orcad-live-successor-migration-resume', () => ({
  resumeOrcadLiveSuccessorMigration: steps.successorResume
}))
vi.mock('./orcad-live-retirement-recovery-inspection', () => ({
  inspectOrcadLiveRetirementRecovery: steps.retirement
}))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: steps.cutover
}))

const manifest = { migrationId: 'migration' }
beforeEach(() => {
  vi.resetAllMocks()
  steps.selectAuthority.mockReturnValue({ mode: 'original', assertCurrent: steps.assertAuthority })
  steps.retirement.mockReturnValue([])
  steps.cutover.mockReturnValue([
    { intent: { manifest }, journal: { phase: 'destination-staged' } }
  ])
  steps.cleanup.mockResolvedValue({ phase: 'runtime-surfaces-removed' })
  steps.reflush.mockResolvedValue({ phase: 'runtime-surfaces-removed' })
  steps.deliveries.mockResolvedValue({ phase: 'source-deliveries-retired', receipts: [] })
  steps.completion.mockResolvedValue({ phase: 'source-completion-prepared' })
  steps.routes.mockResolvedValue({ phase: 'source-routes-removed', checkpoint: { version: 1 } })
  steps.finalize.mockResolvedValue({
    phase: 'source-retired',
    sourceRetirement: 'complete',
    receipts: []
  })
})
function run(signal = new AbortController().signal, recoveryOnly?: boolean) {
  return resumeOrcadLiveMigration({
    profileDirectory: 'profile',
    migrationId: 'migration',
    signal,
    ...(recoveryOnly === undefined ? {} : { recoveryOnly })
  } as Parameters<typeof resumeOrcadLiveMigration>[0])
}

it('resumes destination, installs profile and cleans runtime before acknowledging completion', async () => {
  const result = await run()
  expect(steps.destination.mock.invocationCallOrder[0]).toBeLessThan(
    steps.profile.mock.invocationCallOrder[0]
  )
  expect(steps.profile.mock.invocationCallOrder[0]).toBeLessThan(
    steps.cleanup.mock.invocationCallOrder[0]
  )
  expect(steps.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
    steps.deliveries.mock.invocationCallOrder[0]
  )
  expect(result).toMatchObject({
    completionPreparation: { phase: 'source-completion-prepared' },
    phase: 'source-retired',
    sourceRetirement: 'complete',
    receipts: []
  })
})
it('prepares completion only after delivery retirement', async () => {
  await run()
  expect(steps.deliveries.mock.invocationCallOrder[0]).toBeLessThan(
    steps.completion.mock.invocationCallOrder[0]
  )
  expect(steps.completion.mock.invocationCallOrder[0]).toBeLessThan(
    steps.routes.mock.invocationCallOrder[0]
  )
  expect(steps.routes.mock.invocationCallOrder[0]).toBeLessThan(
    steps.finalize.mock.invocationCallOrder[0]
  )
})
it.each([undefined, true])('passes explicit recovery mode %s to route retirement', async (mode) => {
  await run(new AbortController().signal, mode)
  expect(steps.routes.mock.calls[0][0].recoveryOnly).toBe(mode)
})
it('propagates route failure without retrying removal as recovery', async () => {
  steps.routes.mockRejectedValue(new Error('route checkpoint uncertain'))
  await expect(run()).rejects.toThrow('route checkpoint uncertain')
  expect(steps.routes).toHaveBeenCalledOnce()
  expect(steps.finalize).not.toHaveBeenCalled()
})
it.each([1, 2])(
  'revalidates v%s completed retries without repeating source retirement',
  async (version) => {
    steps.successorFinalize.mockResolvedValue({ sourceRetirement: 'complete' })
    steps.retirement.mockReturnValue([
      {
        record: { release: { cutover: { manifest } } },
        state: 'profile-installed',
        completedCutover: { phase: 'source-retired', sourceCompletion: { version } }
      }
    ])
    await expect(run()).resolves.toMatchObject({ sourceRetirement: 'complete' })
    for (const stage of [
      steps.cutover,
      steps.destination,
      steps.profile,
      steps.cleanup,
      steps.reflush,
      steps.deliveries,
      steps.completion,
      steps.routes
    ]) {
      expect(stage).not.toHaveBeenCalled()
    }
    expect(version === 1 ? steps.finalize : steps.successorFinalize).toHaveBeenCalledOnce()
    expect(version === 1 ? steps.successorFinalize : steps.finalize).not.toHaveBeenCalled()
  }
)

it.each([undefined, 3])('refuses unknown completed evidence version %s', async (version) => {
  steps.retirement.mockReturnValue([
    {
      record: { release: { cutover: { manifest } } },
      state: 'profile-installed',
      completedCutover: { phase: 'source-retired', sourceCompletion: { version } }
    }
  ])
  await expect(run()).rejects.toThrow('completion_evidence_version_required')
  expect(steps.finalize).not.toHaveBeenCalled()
  expect(steps.successorFinalize).not.toHaveBeenCalled()
})

it.each([1, 2])('never falls back after v%s completed recovery fails', async (version) => {
  steps.retirement.mockReturnValue([
    {
      record: { release: { cutover: { manifest } } },
      state: 'profile-installed',
      completedCutover: { phase: 'source-retired', sourceCompletion: { version } }
    }
  ])
  const selected = version === 1 ? steps.finalize : steps.successorFinalize
  selected.mockRejectedValue(new Error('completion-unverifiable'))
  await expect(run()).rejects.toThrow('completion-unverifiable')
  expect(selected).toHaveBeenCalledOnce()
  expect(version === 1 ? steps.successorFinalize : steps.finalize).not.toHaveBeenCalled()
  expect(steps.deliveries).not.toHaveBeenCalled()
})
it('propagates uncertain final persistence without acknowledging completion', async () => {
  steps.finalize.mockRejectedValue(new Error('final flush uncertain'))
  await expect(run()).rejects.toThrow('final flush uncertain')
  expect(steps.finalize).toHaveBeenCalledOnce()
})
it('honors cancellation before final persistence', async () => {
  const controller = new AbortController()
  steps.routes.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
  expect(steps.finalize).not.toHaveBeenCalled()
})
it('honors cancellation before route retirement', async () => {
  const controller = new AbortController()
  steps.completion.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
  expect(steps.routes).not.toHaveBeenCalled()
})
it('propagates completion preparation failures', async () => {
  steps.completion.mockRejectedValue(new Error('preparation flush failed'))
  await expect(run()).rejects.toThrow('preparation flush failed')
})
it('honors cancellation before completion preparation', async () => {
  const controller = new AbortController()
  steps.deliveries.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
  expect(steps.completion).not.toHaveBeenCalled()
})
it('skips destination admission after the destination commit', async () => {
  steps.cutover.mockReturnValue([
    { intent: { manifest }, journal: { phase: 'destination-committed' } }
  ])
  await run()
  expect(steps.destination).not.toHaveBeenCalled()
  expect(steps.profile).toHaveBeenCalledOnce()
})
it('goes directly to retained cleanup after profile installation', async () => {
  steps.retirement.mockReturnValue([
    { record: { release: { cutover: { manifest } } }, state: 'profile-installed' }
  ])
  await run()
  expect(steps.cutover).toHaveBeenCalledOnce()
  expect(steps.destination).not.toHaveBeenCalled()
  expect(steps.profile).not.toHaveBeenCalled()
  expect(steps.cleanup).toHaveBeenCalledOnce()
})

it('selects unfinished successor recovery before invoking any ordinary stage', async () => {
  steps.selectAuthority.mockReturnValue({ mode: 'successor', assertCurrent: steps.assertAuthority })
  steps.successorResume.mockResolvedValue({ sourceRetirement: 'complete' })
  await expect(run()).resolves.toEqual({ sourceRetirement: 'complete' })
  expect(steps.successorResume).toHaveBeenCalledOnce()
  for (const stage of [
    steps.destination,
    steps.profile,
    steps.cleanup,
    steps.deliveries,
    steps.finalize
  ]) {
    expect(stage).not.toHaveBeenCalled()
  }
})

it.each(['selection', 'assertion', 'successor'] as const)(
  'never falls back to ordinary recovery after %s failure',
  async (failure) => {
    steps.selectAuthority.mockReturnValue({
      mode: 'successor',
      assertCurrent: steps.assertAuthority
    })
    const error = new Error('authority-unverifiable')
    if (failure === 'selection') {
      steps.selectAuthority.mockImplementation(() => {
        throw error
      })
    }
    if (failure === 'assertion') {
      steps.assertAuthority.mockImplementation(() => {
        throw error
      })
    }
    if (failure === 'successor') {
      steps.successorResume.mockRejectedValue(error)
    }
    await expect(run()).rejects.toThrow('authority-unverifiable')
    expect(steps.destination).not.toHaveBeenCalled()
    expect(steps.cleanup).not.toHaveBeenCalled()
    expect(steps.finalize).not.toHaveBeenCalled()
  }
)
it('refuses missing phase evidence without restarting admission', async () => {
  steps.cutover.mockReturnValue([])
  await expect(run()).rejects.toThrow('phase_observation_required')
  expect(steps.destination).not.toHaveBeenCalled()
  expect(steps.cleanup).not.toHaveBeenCalled()
})
it('does not proceed to cleanup when profile installation fails', async () => {
  steps.profile.mockRejectedValue(new Error('profile flush failed'))
  await expect(run()).rejects.toThrow('profile flush failed')
  expect(steps.cleanup).not.toHaveBeenCalled()
})
it('refuses conflicting retirement evidence before dispatching any stage', async () => {
  steps.retirement.mockReturnValue([
    { record: { release: { cutover: { manifest } } }, state: 'conflict' }
  ])
  await expect(run()).rejects.toThrow('profile_installation_conflict')
  expect(steps.destination).not.toHaveBeenCalled()
  expect(steps.profile).not.toHaveBeenCalled()
  expect(steps.cleanup).not.toHaveBeenCalled()
})
it('propagates unresolved cleanup recovery instead of returning a completed phase', async () => {
  steps.cleanup.mockRejectedValue(new Error('restart reconstruction required'))
  await expect(run()).rejects.toThrow('restart reconstruction required')
})
it('honors cancellation between destination work and profile installation', async () => {
  const controller = new AbortController()
  steps.destination.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
  expect(steps.profile).not.toHaveBeenCalled()
})

it.each([undefined, true])(
  'reflushes existing cleanup before explicit retirement mode %s',
  async (recoveryOnly) => {
    steps.retirement.mockReturnValue([
      {
        record: { release: { cutover: { manifest } } },
        state: 'profile-installed',
        runtimeCleanupRecorded: true
      }
    ])
    await run(new AbortController().signal, recoveryOnly)
    expect(steps.cleanup).not.toHaveBeenCalled()
    expect(steps.reflush.mock.invocationCallOrder[0]).toBeLessThan(
      steps.deliveries.mock.invocationCallOrder[0]
    )
    const options = steps.deliveries.mock.calls[0][0]
    expect(options.recoveryOnly).toBe(recoveryOnly)
  }
)

it('does not dispatch retirement after failed checkpoint reflush', async () => {
  steps.retirement.mockReturnValue([
    {
      record: { release: { cutover: { manifest } } },
      state: 'profile-installed',
      runtimeCleanupRecorded: true
    }
  ])
  steps.reflush.mockRejectedValue(new Error('reflush failed'))
  await expect(run()).rejects.toThrow('reflush failed')
  expect(steps.cleanup).not.toHaveBeenCalled()
  expect(steps.deliveries).not.toHaveBeenCalled()
})

it('honors cancellation between cleanup and retirement', async () => {
  const controller = new AbortController()
  steps.cleanup.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
  expect(steps.deliveries).not.toHaveBeenCalled()
})

it('does not retry initial retirement as recovery after any failure', async () => {
  steps.deliveries.mockRejectedValue(new Error('source authority changed'))
  await expect(run()).rejects.toThrow('source authority changed')
  expect(steps.deliveries).toHaveBeenCalledOnce()
  expect(steps.deliveries.mock.calls[0][0].recoveryOnly).toBeUndefined()
})

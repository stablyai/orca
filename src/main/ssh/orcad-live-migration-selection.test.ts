import { beforeEach, expect, it, vi } from 'vitest'
import {
  listSelectedOrcadLiveMigrations,
  resumeSelectedOrcadLiveMigration
} from './orcad-live-migration-selection'

const f = vi.hoisted(() => ({
  resolve: vi.fn(),
  cutovers: vi.fn(),
  retirements: vi.fn(),
  resume: vi.fn(),
  enabled: vi.fn(),
  durable: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: f.resolve }))
vi.mock('../../shared/pty-ownership-transfer-release-gate', () => ({
  isPtyOwnershipTransferMutationEnabled: f.enabled
}))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: f.cutovers
}))
vi.mock('./orcad-live-retirement-recovery-inspection', () => ({
  inspectOrcadLiveRetirementRecovery: f.retirements
}))
vi.mock('./orcad-live-migration-resume', () => ({ resumeOrcadLiveMigration: f.resume }))
const context = {
  store: { isOrcadLiveCompletionDurable: f.durable } as never,
  runtime: {} as never
}
const selection = { selector: 'server', migrationId: 'migration', mode: 'initial' as const }
function entry(environment = 'environment') {
  return {
    state: 'journal-retained' as const,
    intent: {
      destinationEnvironmentId: environment,
      phase: 'source-fenced',
      manifest: {
        migrationId: 'migration',
        source: { sshTargetId: 'target' },
        payload: { secret: 'catalog' }
      },
      liveTerminalBindings: [
        { identity: { destinationRuntimeId: 'runtime', ownerLease: 'secret' } }
      ]
    },
    journal: { phase: 'destination-committed' }
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  f.enabled.mockReturnValue(true)
  f.durable.mockReturnValue(true)
  f.resolve.mockReturnValue({ id: 'environment', runtimeId: 'runtime' })
  f.cutovers.mockReturnValue([entry()])
  f.retirements.mockReturnValue([])
  f.resume.mockResolvedValue({
    phase: 'source-retired',
    sourceRetirement: 'complete',
    receipts: [{ secret: 'receipt' }],
    checkpoint: { secret: 'checkpoint' }
  })
})

it('lists only selected migration progress, without retained catalog or credential data', () => {
  f.cutovers.mockReturnValue([entry(), entry('other')])
  expect(listSelectedOrcadLiveMigrations('/profile', context.store, ' server ')).toEqual([
    {
      migrationId: 'migration',
      destinationEnvironmentId: 'environment',
      sourceSshTargetId: 'target',
      phase: 'destination-committed',
      phaseEvidence: 'journal-retained',
      receipts: { recorded: 0, total: 1 },
      sourceRetirement: 'pending'
    }
  ])
  expect(f.resolve).toHaveBeenCalledWith('/profile', 'server')
})

it.each(['initial', 'recovery'] as const)(
  'passes trusted context and explicit %s mode, returning only progress',
  async (mode) => {
    const signal = new AbortController().signal
    const result = await resumeSelectedOrcadLiveMigration(
      '/profile',
      context,
      { ...selection, mode },
      signal
    )
    expect(f.resume).toHaveBeenCalledWith({
      ...context,
      profileDirectory: '/profile',
      migrationId: 'migration',
      signal,
      recoveryOnly: mode === 'recovery'
    })
    expect(result).toEqual({
      migrationId: 'migration',
      destinationEnvironmentId: 'environment',
      sourceSshTargetId: 'target',
      phase: 'source-retired',
      phaseEvidence: 'journal-retained',
      profileState: 'profile-installed',
      receipts: { recorded: 1, total: 1 },
      sourceRetirement: 'complete'
    })
  }
)

it.each(['intent-only', 'phase-unverifiable'] as const)(
  'preserves %s evidence instead of presenting the intent phase as an observed journal',
  (state) => {
    f.cutovers.mockReturnValue([{ ...entry(), journal: undefined, state }])
    expect(listSelectedOrcadLiveMigrations('/profile', context.store, 'server')[0]).toEqual({
      migrationId: 'migration',
      destinationEnvironmentId: 'environment',
      sourceSshTargetId: 'target',
      phase: 'source-fenced',
      phaseEvidence: state,
      receipts: { recorded: 0, total: 1 },
      sourceRetirement: 'pending'
    })
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.durable).not.toHaveBeenCalled()
  }
)

it.each(['disabled', 'missing', 'runtime', 'mode', 'aborted'] as const)(
  'refuses %s before coordinator mutation',
  async (kind) => {
    const controller = new AbortController()
    if (kind === 'disabled') {
      f.enabled.mockReturnValue(false)
    }
    if (kind === 'missing') {
      f.cutovers.mockReturnValue([entry('other')])
    }
    if (kind === 'runtime') {
      f.resolve.mockReturnValue({ id: 'environment', runtimeId: 'replacement' })
    }
    if (kind === 'aborted') {
      controller.abort(new Error('canceled'))
    }
    const args = kind === 'mode' ? { ...selection, mode: 'automatic' as never } : selection
    await expect(
      resumeSelectedOrcadLiveMigration('/profile', context, args, controller.signal)
    ).rejects.toThrow()
    expect(f.resume).not.toHaveBeenCalled()
  }
)

it('propagates inspection conflicts without producing an empty progress list', () => {
  f.retirements.mockImplementation(() => {
    throw new Error('receipt conflict')
  })
  expect(() => listSelectedOrcadLiveMigrations('/profile', context.store, 'server')).toThrow(
    'receipt conflict'
  )
})

function retirement(state: 'prepared' | 'profile-installed' | 'conflict', completed = false) {
  return {
    state,
    record: { release: { cutover: { manifest: { migrationId: 'migration' } } } },
    sourceCancellationReceipts: { recorded: 1, total: 1 },
    ...(completed
      ? {
          completedCutover: {
            phase: 'source-retired',
            sourceCompletion: { secret: 'evidence' },
            manifest: { secret: 'catalog' }
          }
        }
      : {})
  }
}

it('reports completion only from validated installed-profile retirement evidence', () => {
  const retained = entry()
  retained.journal.phase = 'source-retired'
  f.cutovers.mockReturnValue([retained])
  f.retirements.mockReturnValue([retirement('profile-installed', true)])
  expect(listSelectedOrcadLiveMigrations('/profile', context.store, 'server')).toEqual([
    {
      migrationId: 'migration',
      destinationEnvironmentId: 'environment',
      sourceSshTargetId: 'target',
      phase: 'source-retired',
      phaseEvidence: 'journal-retained',
      profileState: 'profile-installed',
      receipts: { recorded: 1, total: 1 },
      sourceRetirement: 'complete'
    }
  ])
  expect(f.durable).toHaveBeenCalledWith(retirement('profile-installed', true).completedCutover)
})

it('keeps validated but unacknowledged in-memory completion pending', () => {
  const retained = entry()
  retained.journal.phase = 'source-retired'
  f.cutovers.mockReturnValue([retained])
  f.retirements.mockReturnValue([retirement('profile-installed', true)])
  f.durable.mockReturnValue(false)
  expect(
    listSelectedOrcadLiveMigrations('/profile', context.store, 'server')[0].sourceRetirement
  ).toBe('pending')
})

it('does not reuse durability proof for a different completed candidate', () => {
  const original = retirement('profile-installed', true)
  f.durable.mockImplementation(
    (candidate) => JSON.stringify(candidate) === JSON.stringify(original.completedCutover)
  )
  f.retirements.mockReturnValue([original])
  expect(
    listSelectedOrcadLiveMigrations('/profile', context.store, 'server')[0].sourceRetirement
  ).toBe('complete')
  f.retirements.mockReturnValue([
    {
      ...original,
      completedCutover: { ...original.completedCutover, updatedAt: '2030-01-01T00:00:00.000Z' }
    }
  ])
  expect(
    listSelectedOrcadLiveMigrations('/profile', context.store, 'server')[0].sourceRetirement
  ).toBe('pending')
})

it.each(['missing', 'installed-without-completion', 'prepared', 'conflict'] as const)(
  'does not infer completion from the journal phase with %s retirement evidence',
  (state) => {
    const retained = entry()
    retained.journal.phase = 'source-retired'
    f.cutovers.mockReturnValue([retained])
    f.retirements.mockReturnValue(
      state === 'missing'
        ? []
        : [
            state === 'installed-without-completion'
              ? retirement('profile-installed')
              : retirement(state, true)
          ]
    )
    expect(
      listSelectedOrcadLiveMigrations('/profile', context.store, 'server')[0].sourceRetirement
    ).toBe('pending')
  }
)

it('does not borrow completion evidence from another migration', () => {
  const other = retirement('profile-installed', true)
  other.record.release.cutover.manifest.migrationId = 'other-migration'
  f.retirements.mockReturnValue([other])
  expect(
    listSelectedOrcadLiveMigrations('/profile', context.store, 'server')[0].sourceRetirement
  ).toBe('pending')
})

it('reflects acknowledged progress rather than a previously completed listing', async () => {
  f.retirements.mockReturnValue([retirement('profile-installed', true)])
  f.resume.mockResolvedValue({
    phase: 'source-routes-removed',
    sourceRetirement: 'pending',
    receipts: []
  })
  await expect(
    resumeSelectedOrcadLiveMigration('/profile', context, selection, new AbortController().signal)
  ).resolves.toMatchObject({
    phase: 'source-routes-removed',
    sourceRetirement: 'pending',
    receipts: { recorded: 0, total: 1 }
  })
})

it('does not acknowledge completion when the final flush fails', async () => {
  f.resume.mockRejectedValue(new Error('final acknowledgment lost'))
  await expect(
    resumeSelectedOrcadLiveMigration('/profile', context, selection, new AbortController().signal)
  ).rejects.toThrow('final acknowledgment lost')
})

it('does not acknowledge completion after cancellation while the coordinator resolves', async () => {
  const controller = new AbortController()
  f.resume.mockImplementation(async () => {
    controller.abort(new Error('canceled after final flush'))
    return { phase: 'source-retired', sourceRetirement: 'complete', receipts: [] }
  })
  await expect(
    resumeSelectedOrcadLiveMigration('/profile', context, selection, controller.signal)
  ).rejects.toThrow('canceled after final flush')
})

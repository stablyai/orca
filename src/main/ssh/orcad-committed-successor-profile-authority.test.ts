import { beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import {
  withOrcadCommittedProfileAuthority,
  withOrcadCommittedSuccessorProfileAuthority
} from './orcad-committed-profile-authority'
import type { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'

type ProfileContext = Parameters<
  Parameters<typeof withOrcadCommittedSuccessorProfileAuthority>[1]
>[0]

const mocked = vi.hoisted(() => ({
  inspect: vi.fn(),
  original: vi.fn(),
  successor: vi.fn(),
  native: vi.fn(),
  sourceOwner: vi.fn(),
  completed: vi.fn()
}))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: mocked.inspect
}))
vi.mock('./orcad-outgoing-authority', () => ({
  withOutgoingOrcadAuthority: mocked.original,
  withOutgoingOrcadSuccessorAuthority: mocked.successor
}))
vi.mock('./orcad-live-completed-recovery', () => ({
  validateOrcadLiveCompletedRecovery: mocked.completed
}))

beforeEach(() => {
  vi.resetAllMocks()
  const admit = async (
    ...[_directory, options, run]: Parameters<typeof withOutgoingOrcadAuthority>
  ) => {
    options.assertEvidence()
    return run({
      pairingCode: 'modeled-pairing',
      assertSourceCutoverOwner: mocked.sourceOwner,
      assertAuthority: () => {
        mocked.native()
        options.assertEvidence()
      }
    })
  }
  mocked.original.mockImplementation(admit)
  mocked.successor.mockImplementation(admit)
})

function fixture() {
  const { cutover } = liveSourceRetirementFixture()
  const entry = { intent: structuredClone(cutover), journal: structuredClone(cutover) }
  mocked.inspect.mockImplementation(() => [entry])
  const options = {
    profileDirectory: '/modeled-profile',
    store: {} as Store,
    migrationId: cutover.manifest.migrationId,
    signal: new AbortController().signal
  }
  return { cutover, entry, options }
}

it.each(['original', 'successor'] as const)(
  'explicitly chooses the %s authority wrapper',
  async (mode) => {
    const f = fixture()
    const operation = vi.fn(async (context: ProfileContext) => {
      context.assertAuthority()
      expect(context.cutover).toEqual(f.cutover)
      expect(context.pairingCode).toBe('modeled-pairing')
      return 'done'
    })
    const wrapper =
      mode === 'original'
        ? withOrcadCommittedProfileAuthority
        : withOrcadCommittedSuccessorProfileAuthority
    await expect(wrapper(f.options, operation)).resolves.toBe('done')
    expect(mocked[mode]).toHaveBeenCalledOnce()
    expect(mocked[mode === 'original' ? 'successor' : 'original']).not.toHaveBeenCalled()
    expect(mocked.sourceOwner).toHaveBeenCalledWith('fenced')
    expect(mocked[mode].mock.calls[0][1].binding).toEqual({
      version: 1,
      identity: f.cutover.liveTerminalBindings![0].identity,
      destinationEnvironmentId: f.cutover.destinationEnvironmentId,
      sourceSshTargetId: f.cutover.manifest.source.sshTargetId,
      sourceSshTargetGeneration: f.cutover.manifest.source.sshTargetGeneration
    })
  }
)

it('refuses successor completed admission without explicit opt-in', async () => {
  const f = fixture()
  f.entry.journal.phase = 'source-retired'
  const operation = vi.fn()
  const runtimeOptions = { ...f.options }
  await expect(
    withOrcadCommittedSuccessorProfileAuthority(runtimeOptions, operation)
  ).rejects.toThrow('commit_required')
  expect(operation).not.toHaveBeenCalled()
  expect(mocked.successor).not.toHaveBeenCalled()
  expect(mocked.completed).not.toHaveBeenCalled()
})

it('does not disable original completed admission', async () => {
  const f = fixture()
  f.entry.journal.phase = 'source-retired'
  Object.assign(f.entry.journal, {
    sourceCompletion: {
      version: 1,
      retirementRecordSha256: 'a'.repeat(64),
      sourceRouteCheckpointSha256: 'b'.repeat(64)
    }
  })
  mocked.completed.mockReturnValue({ record: { release: { cutover: f.cutover } } })
  await expect(
    withOrcadCommittedProfileAuthority({ ...f.options, allowCompleted: true }, async (context) => {
      context.assertAuthority()
      expect(context.cutover).toEqual(f.cutover)
      return 'original-completed'
    })
  ).resolves.toBe('original-completed')
  expect(mocked.original).toHaveBeenCalledOnce()
})

it('disables successor completion transitions without explicit opt-in', async () => {
  const f = fixture()
  const write = vi.fn()
  const runtimeOptions = { ...f.options }
  await withOrcadCommittedSuccessorProfileAuthority(runtimeOptions, async (context) => {
    expect(() => context.transitionCompletedJournal({}, write)).toThrow('transition_not_enabled')
  })
  expect(write).not.toHaveBeenCalled()
})

it.each(['intent', 'journal'] as const)(
  'refuses %s drift while the callback is active',
  async (field) => {
    const f = fixture()
    await expect(
      withOrcadCommittedSuccessorProfileAuthority(f.options, async (context) => {
        context.assertAuthority()
        f.entry[field].updatedAt = '2026-09-09T12:00:00.000Z'
        context.assertAuthority()
      })
    ).rejects.toThrow('journal_changed')
  }
)

it('refuses missing evidence at admission', async () => {
  const f = fixture()
  mocked.inspect.mockReturnValueOnce([])
  await expect(withOrcadCommittedSuccessorProfileAuthority(f.options, vi.fn())).rejects.toThrow(
    'commit_required'
  )
  expect(mocked.successor).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)(
  'revokes retained callbacks after %s',
  async (settlement) => {
    const f = fixture()
    let retained: ProfileContext | undefined
    const result = withOrcadCommittedSuccessorProfileAuthority(f.options, async (context) => {
      retained = context
      context.assertAuthority()
      if (settlement === 'reject') {
        throw new Error('operation-failed')
      }
      return 'done'
    })
    await (settlement === 'reject'
      ? expect(result).rejects.toThrow('operation-failed')
      : expect(result).resolves.toBe('done'))
    mocked.native.mockClear()
    expect(() => retained!.assertAuthority()).toThrow('authority_released')
    expect(() => retained!.transitionCompletedJournal({}, vi.fn())).toThrow(
      'transition_not_enabled'
    )
    expect(mocked.native).not.toHaveBeenCalled()
  }
)

it('checks journal authority after the callback await without caller assertions', async () => {
  const f = fixture()
  await expect(
    withOrcadCommittedSuccessorProfileAuthority(f.options, async () => {
      await Promise.resolve()
      f.entry.journal.updatedAt = '2026-09-09T12:00:00.000Z'
      return 'not-confirmed'
    })
  ).rejects.toThrow('journal_changed')
})

it('refuses aborted admission before inspecting the journal', async () => {
  const f = fixture()
  await expect(
    withOrcadCommittedSuccessorProfileAuthority(
      { ...f.options, signal: AbortSignal.abort() },
      vi.fn()
    )
  ).rejects.toThrow()
  expect(mocked.inspect).not.toHaveBeenCalled()
  expect(mocked.successor).not.toHaveBeenCalled()
})

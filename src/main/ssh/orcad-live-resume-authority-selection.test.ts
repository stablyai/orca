import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import {
  OrcadLiveCutoverIntentStore,
  parseOrcadLiveCutoverIntent
} from './orcad-live-cutover-intent-store'
import { selectOrcadLiveResumeAuthority } from './orcad-live-resume-authority-selection'

const mocked = vi.hoisted(() => ({
  historical: vi.fn(),
  current: vi.fn(),
  original: vi.fn(),
  successor: vi.fn(),
  originalAssertion: vi.fn(),
  successorAssertion: vi.fn()
}))
vi.mock('./profile-lifetime-admission', () => ({
  readCurrentProfileLifetimeParticipation: mocked.current
}))
vi.mock('./orcad-live-profile-participation', () => ({
  readOrcadLiveProfileParticipation: mocked.historical,
  retainOrcadLiveProfileParticipation: mocked.original
}))
vi.mock('./orcad-live-successor-profile-authority', () => ({
  retainOrcadLiveSuccessorProfileAuthority: mocked.successor
}))
let root: string
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'orca-resume-authority-selection-'))
  mocked.original.mockReturnValue(mocked.originalAssertion)
  mocked.successor.mockReturnValue(mocked.successorAssertion)
  mocked.historical.mockReturnValue({ participation: { processIncarnation: 'original' } })
  mocked.current.mockReturnValue({ processIncarnation: 'original' })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  const intent = parseOrcadLiveCutoverIntent({
    version: 2,
    phase: 'source-fenced',
    profileParticipationRequired: true,
    destinationEnvironmentId: 'environment',
    manifest,
    liveTerminalBindings: bindings,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt
  })
  const store = new OrcadLiveCutoverIntentStore(root)
  store.persist(intent)
  const remove = () =>
    unlinkSync(
      join(
        root,
        'orcad-live-cutover-intents',
        `${createHash('sha256').update(intent.identity.bridgeId).digest('hex')}.json`
      )
    )
  return { intent, store, remove, select: () => selectOrcadLiveResumeAuthority(root, intent) }
}

it.each(['same', 'different'] as const)(
  'selects from %s native process incarnation without probing alternate authority',
  (kind) => {
    const f = fixture()
    mocked.current.mockReturnValue({
      processIncarnation: kind === 'same' ? 'original' : 'successor'
    })
    const selected = f.select()
    const mode = kind === 'same' ? 'original' : 'successor'
    expect(selected.mode).toBe(mode)
    expect(mocked[mode]).toHaveBeenCalledWith(root, f.intent)
    expect(mocked[mode === 'original' ? 'successor' : 'original']).not.toHaveBeenCalled()
    selected.assertCurrent()
    expect(
      mocked[mode === 'original' ? 'originalAssertion' : 'successorAssertion']
    ).toHaveBeenCalledTimes(2)
  }
)

it.each(['historical', 'current'] as const)(
  'does not infer successor authority from absent %s participation',
  (which) => {
    const f = fixture()
    mocked[which].mockReturnValue(null)
    mocked.original.mockImplementation(() => {
      throw new Error('participation_unavailable')
    })
    expect(f.select).toThrow('participation_unavailable')
    expect(mocked.successor).not.toHaveBeenCalled()
  }
)

it('retains the explicit original legacy path when neither participation record exists', () => {
  const f = fixture()
  f.remove()
  const legacy = parseOrcadLiveCutoverIntent({
    ...f.intent,
    profileParticipationRequired: undefined
  })
  f.store.persist(legacy)
  mocked.historical.mockReturnValue(null)
  mocked.current.mockReturnValue(null)
  mocked.original.mockReturnValue(undefined)
  const selected = selectOrcadLiveResumeAuthority(root, legacy)
  expect(selected.mode).toBe('original')
  expect(() => selected.assertCurrent()).not.toThrow()
  expect(mocked.successor).not.toHaveBeenCalled()
})

it.each(['original', 'successor'] as const)(
  'never falls back when selected %s authority refuses acquisition',
  (mode) => {
    const f = fixture()
    mocked.current.mockReturnValue({ processIncarnation: mode })
    mocked[mode].mockImplementation(() => {
      throw new Error('authority_refused')
    })
    expect(f.select).toThrow('authority_refused')
    expect(mocked[mode === 'original' ? 'successor' : 'original']).not.toHaveBeenCalled()
  }
)

it.each(['original', 'successor'] as const)(
  'retains %s selection and propagates later authority loss',
  (mode) => {
    const f = fixture()
    mocked.current.mockReturnValue({ processIncarnation: mode })
    const selected = f.select()
    mocked[mode === 'original' ? 'originalAssertion' : 'successorAssertion'].mockImplementation(
      () => {
        throw new Error('authority_lost')
      }
    )
    expect(() => selected.assertCurrent()).toThrow('authority_lost')
    expect(mocked[mode === 'original' ? 'successor' : 'original']).not.toHaveBeenCalled()
    expect(mocked[mode]).toHaveBeenCalledOnce()
  }
)

it('refuses absent saved intent before native authority selection', () => {
  const f = fixture()
  f.remove()
  expect(f.select).toThrow('intent_changed')
  expect(mocked.current).not.toHaveBeenCalled()
  expect(mocked.historical).not.toHaveBeenCalled()
})

it('rereads saved intent after native authority assertions', () => {
  const f = fixture()
  const selected = f.select()
  mocked.originalAssertion.mockImplementation(f.remove)
  expect(() => selected.assertCurrent()).toThrow('intent_changed')
})

it('refuses saved intent mutation on subsequent assertions', () => {
  const f = fixture()
  const selected = f.select()
  f.remove()
  f.store.persist({ ...f.intent, updatedAt: '2026-09-08T12:00:00.000Z' })
  expect(() => selected.assertCurrent()).toThrow('intent_changed')
})

it('refuses intent mutation during acquisition without changing selected authority', () => {
  const f = fixture()
  mocked.successor.mockImplementation(() => {
    f.remove()
    return mocked.successorAssertion
  })
  mocked.current.mockReturnValue({ processIncarnation: 'successor' })
  expect(f.select).toThrow('intent_changed')
  expect(mocked.original).not.toHaveBeenCalled()
})

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import {
  OrcadLiveCutoverIntentStore,
  parseOrcadLiveCutoverIntent
} from './orcad-live-cutover-intent-store'
import {
  captureProfileLifetimeParticipation,
  type ProfileLifetimeParticipation
} from './profile-lifetime-participation'
import {
  prepareOrcadLiveProfileParticipation,
  readOrcadLiveProfileParticipation,
  retainOrcadLiveProfileParticipation
} from './orcad-live-profile-participation'
import * as secure from '../../shared/secure-file'
import { retainOrcadLiveSuccessorProfileAuthority } from './orcad-live-successor-profile-authority'

const current = vi.hoisted(() => vi.fn<() => ProfileLifetimeParticipation | null>())
vi.mock('./profile-lifetime-admission', () => ({
  readCurrentProfileLifetimeParticipation: current
}))

let directory: string
let root: string
let participant: ProfileLifetimeParticipation
let intent: ReturnType<typeof parseOrcadLiveCutoverIntent>

beforeEach(() => {
  current.mockReset()
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-live-participation-unit-')))
  root = join(directory, 'profile')
  mkdirSync(root)
  writeFileSync(join(root, 'profile-lifetime.lock'), '')
  participant = captureProfileLifetimeParticipation(root, randomUUID(), () => {})
  current.mockReturnValue(participant)
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  intent = parseOrcadLiveCutoverIntent({
    version: 2,
    phase: 'source-fenced',
    profileParticipationRequired: true,
    destinationEnvironmentId: 'environment',
    manifest,
    liveTerminalBindings: bindings,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

const recordsDirectory = (profile = root) => join(profile, 'orcad-live-profile-participation')
const file = () => join(recordsDirectory(), readdirSync(recordsDirectory())[0])
const prepare = (profileDirectory = root, assertAuthority = () => {}) =>
  prepareOrcadLiveProfileParticipation({ profileDirectory, intent, assertAuthority })

it('persists exact evidence and durably reflushes same-process retries', () => {
  const authority = vi.fn()
  const retained = prepare(root, authority)!
  retained()
  expect(authority).toHaveBeenCalledTimes(2)
  const saved = readOrcadLiveProfileParticipation(root, intent)
  expect(saved).toMatchObject({
    version: 1,
    identity: intent.identity,
    physicalProfile: root,
    participation: participant
  })
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  prepare()!()
  expect(write).toHaveBeenCalledOnce()
  expect(readOrcadLiveProfileParticipation(root, intent)).toEqual(saved)
  retainOrcadLiveProfileParticipation(root, intent)!()
})

it.each(['destination', 'second-terminal-lease', 'timestamp'] as const)(
  'binds the full immutable intent including %s without overwriting evidence',
  (change) => {
    const retained = prepare()!
    const original = structuredClone(intent)
    const before = readFileSync(file())
    if (change === 'destination') {
      intent.destinationEnvironmentId = 'other'
    } else if (change === 'second-terminal-lease') {
      intent.liveTerminalBindings = intent.liveTerminalBindings!.map((binding, index) =>
        index === 1
          ? { ...binding, identity: { ...binding.identity, ownerLease: 'other' } }
          : binding
      )
    } else {
      intent.updatedAt = '2026-09-07T00:00:00.000Z'
    }
    expect(retained).not.toThrow()
    expect(() => readOrcadLiveProfileParticipation(root, intent)).toThrow('intent_changed')
    expect(() => prepare()).toThrow('intent_changed')
    expect(readFileSync(file())).toEqual(before)
    expect(readOrcadLiveProfileParticipation(root, original)).not.toBeNull()
  }
)

it('leaves absent legacy participation untouched without creating record directories', () => {
  intent = parseOrcadLiveCutoverIntent({ ...intent, profileParticipationRequired: undefined })
  current.mockReturnValue(null)
  const authority = vi.fn()
  expect(prepare(root, authority)).toBeUndefined()
  expect(retainOrcadLiveProfileParticipation(root, intent)).toBeUndefined()
  expect(readOrcadLiveProfileParticipation(root, intent)).toBeNull()
  expect(existsSync(recordsDirectory())).toBe(false)
  expect(authority).not.toHaveBeenCalled()
})

it('refuses a marked intent when both current participation and sidecar are absent', () => {
  current.mockReturnValue(null)
  expect(() => prepare()).toThrow('unavailable')
  expect(() => retainOrcadLiveProfileParticipation(root, intent)).toThrow('unavailable')
  expect(existsSync(recordsDirectory())).toBe(false)
})

it('requires an explicit intent marker before recording current participation', () => {
  intent = parseOrcadLiveCutoverIntent({ ...intent, profileParticipationRequired: undefined })
  expect(() => prepare()).toThrow('marker_required')
  expect(existsSync(recordsDirectory())).toBe(false)
})

it('refuses to backfill missing participation for an already persisted historical intent', () => {
  new OrcadLiveCutoverIntentStore(root).persist(intent)
  const before = new OrcadLiveCutoverIntentStore(root).read(intent.identity)
  expect(() => prepare()).toThrow('historical_missing')
  expect(existsSync(recordsDirectory())).toBe(false)
  expect(new OrcadLiveCutoverIntentStore(root).read(intent.identity)).toEqual(before)
  expect(() => retainOrcadLiveProfileParticipation(root, intent)).toThrow('unavailable')
})

it('never overwrites another process participation with the current native lock holder', () => {
  prepare()
  const before = readFileSync(file())
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  expect(() => prepare()).toThrow('conflict')
  expect(() => retainOrcadLiveProfileParticipation(root, intent)).toThrow('changed')
  expect(readFileSync(file())).toEqual(before)
  expect(readOrcadLiveProfileParticipation(root, intent)?.participation).toEqual(participant)
})

it('refuses loss of current participation even when durable evidence remains', () => {
  const retained = prepare()!
  const before = readFileSync(file())
  current.mockReturnValue(null)
  expect(retained).toThrow('changed')
  expect(() => prepare()).toThrow('unavailable')
  expect(() => retainOrcadLiveProfileParticipation(root, intent)).toThrow('unavailable')
  expect(readFileSync(file())).toEqual(before)
})

it.each(['deleted', 'malformed', 'foreign-record'] as const)(
  'retained proof rejects %s sidecar evidence',
  (change) => {
    const retained = prepare()!
    const path = file()
    if (change === 'deleted') {
      rmSync(path)
    } else if (change === 'malformed') {
      writeFileSync(path, '{}')
    } else {
      const saved = readOrcadLiveProfileParticipation(root, intent)!
      writeFileSync(
        path,
        JSON.stringify({
          ...saved,
          participation: { ...saved.participation, processIncarnation: randomUUID() }
        })
      )
    }
    expect(retained).toThrow()
  }
)

it('retained proof rejects replacement of the physical profile directory', () => {
  const retained = prepare()!
  renameSync(root, join(directory, 'retained-profile'))
  mkdirSync(root)
  expect(retained).toThrow('identity_changed')
})

it('rejects copied evidence during reconstruction under a replaced physical profile', () => {
  prepare()
  const name = readdirSync(recordsDirectory())[0]
  const saved = readFileSync(file())
  renameSync(root, join(directory, 'retained-profile'))
  mkdirSync(recordsDirectory(), { recursive: true })
  writeFileSync(join(recordsDirectory(), name), saved)
  expect(() => retainOrcadLiveProfileParticipation(root, intent)).toThrow('changed')
})

it('rejects profiles outside the native authority root without creating evidence', () => {
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  expect(() => prepare(outside)).toThrow('root_changed')
  expect(existsSync(recordsDirectory(outside))).toBe(false)
})

it('accepts a nested profile while binding its own physical path', () => {
  const nested = join(root, 'profiles', 'work')
  mkdirSync(nested, { recursive: true })
  prepare(nested)!()
  expect(readOrcadLiveProfileParticipation(nested, intent)).toMatchObject({
    physicalProfile: nested,
    participation: participant
  })
  expect(existsSync(recordsDirectory(root))).toBe(false)
})

it('refuses authority loss before creating evidence', () => {
  expect(() =>
    prepare(root, () => {
      throw new Error('authority changed')
    })
  ).toThrow('authority changed')
  expect(existsSync(recordsDirectory())).toBe(false)
})

it('binds successor exclusion read-only without enabling ordinary continuation', () => {
  prepare()
  const before = readFileSync(file())
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  const retained = retainOrcadLiveSuccessorProfileAuthority(root, intent)
  retained()
  expect(readFileSync(file())).toEqual(before)
  expect(() => retainOrcadLiveProfileParticipation(root, intent)).toThrow('changed')
  current.mockReturnValue(participant)
  expect(retained).toThrow('authority_changed')
})

it('never substitutes a successor lock for missing historical migration enrollment', () => {
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  expect(() => retainOrcadLiveSuccessorProfileAuthority(root, intent)).toThrow(
    'participation_missing'
  )
  expect(existsSync(recordsDirectory())).toBe(false)
})

it('refuses successor exclusion from the original process', () => {
  prepare()
  expect(() => retainOrcadLiveSuccessorProfileAuthority(root, intent)).toThrow('same_process')
})

it('retained successor exclusion rejects changed migration evidence', () => {
  prepare()
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  const retained = retainOrcadLiveSuccessorProfileAuthority(root, intent)
  writeFileSync(file(), '{}')
  expect(retained).toThrow()
})

it('refuses copied migration enrollment after physical profile replacement', () => {
  prepare()
  const name = readdirSync(recordsDirectory())[0]
  const saved = readFileSync(file())
  renameSync(root, join(directory, 'original-profile'))
  mkdirSync(recordsDirectory(), { recursive: true })
  writeFileSync(join(recordsDirectory(), name), saved)
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  expect(() => retainOrcadLiveSuccessorProfileAuthority(root, intent)).toThrow('profile_changed')
})

it('binds successor exclusion to the immutable migration intent', () => {
  prepare()
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  expect(() =>
    retainOrcadLiveSuccessorProfileAuthority(root, {
      ...intent,
      destinationEnvironmentId: 'different-destination'
    })
  ).toThrow('intent_changed')
})

it('refuses successor exclusion without current native participation', () => {
  prepare()
  current.mockReturnValue(null)
  expect(() => retainOrcadLiveSuccessorProfileAuthority(root, intent)).toThrow('unavailable')
})

it('retains the nested profile identity separately from the native lock root', () => {
  const nested = join(root, 'profiles', 'nested')
  mkdirSync(nested, { recursive: true })
  prepare(nested)
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  const retained = retainOrcadLiveSuccessorProfileAuthority(nested, intent)
  retained()
  renameSync(nested, join(root, 'profiles', 'old-nested'))
  mkdirSync(nested)
  expect(retained).toThrow('identity_changed')
})

it('refuses migration evidence outside the recorded native lock root', () => {
  prepare()
  const saved = readOrcadLiveProfileParticipation(root, intent)!
  const foreign = { ...participant, physicalRoot: join(directory, 'other-root') }
  writeFileSync(file(), JSON.stringify({ ...saved, participation: foreign }))
  current.mockReturnValue({ ...foreign, processIncarnation: randomUUID() })
  expect(() => retainOrcadLiveSuccessorProfileAuthority(root, intent)).toThrow('profile_changed')
})

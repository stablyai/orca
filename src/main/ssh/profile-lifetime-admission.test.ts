import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeModule from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ProfileLifetimeAdmission from './profile-lifetime-admission'

const native = vi.hoisted(() => {
  const token = {}
  const binding = {
    acquire: vi.fn(() => token),
    assertCurrent: vi.fn<() => void>(),
    release: vi.fn<() => void>()
  }
  const load = vi.fn(() => binding)
  return { token, binding, load, createRequire: vi.fn(() => load) }
})

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeModule>()),
  createRequire: native.createRequire
}))

let directory: string
let profile: string
let admission: typeof ProfileLifetimeAdmission

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  native.binding.acquire.mockReturnValue(native.token)
  native.load.mockReturnValue(native.binding)
  native.createRequire.mockReturnValue(native.load)
  directory = mkdtempSync(join(tmpdir(), 'orca-profile-admission-unit-'))
  profile = join(directory, 'profile')
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  vi.stubEnv('ORCA_PROFILE_LIFETIME_LOCK_ADDON', undefined)
  admission = await import('./profile-lifetime-admission')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

function enable() {
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', '1')
  vi.stubEnv('ORCA_PROFILE_LIFETIME_LOCK_ADDON', join(directory, 'profile-lock.node'))
}

it('keeps legacy admission enabled by default without loading a native addon', () => {
  admission.initializeProfileLifetimeAdmission(profile)
  admission.assertProfileLifetimeAdmission()
  expect(native.createRequire).not.toHaveBeenCalled()
  expect(native.binding.acquire).not.toHaveBeenCalled()
  expect(admission.readCurrentProfileLifetimeParticipation()).toBeNull()
})

it('captures stable participation only while retained native authority is current', () => {
  enable()
  admission.initializeProfileLifetimeAdmission(profile)
  writeFileSync(join(profile, 'profile-lifetime.lock'), '')
  const participation = admission.readCurrentProfileLifetimeParticipation()
  expect(participation?.physicalRoot).toBe(realpathSync.native(profile))
  expect(admission.readCurrentProfileLifetimeParticipation()).toEqual(participation)
  native.binding.assertCurrent.mockImplementation(() => {
    throw new Error('native identity changed')
  })
  expect(() => admission.readCurrentProfileLifetimeParticipation()).toThrow(
    'native identity changed'
  )
})

it('refuses opted-in work before initialization but permits initialization before any work', () => {
  enable()
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('not_initialized')
  admission.initializeProfileLifetimeAdmission(profile)
  admission.assertProfileLifetimeAdmission()
  expect(native.binding.acquire).toHaveBeenCalledOnce()
})

it.each([undefined, 'relative-addon.node'])('latches invalid addon configuration %s', (addon) => {
  enable()
  vi.stubEnv('ORCA_PROFILE_LIFETIME_LOCK_ADDON', addon)
  expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow(
    'configuration_invalid'
  )
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('configuration_invalid')
  enable()
  expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow(
    'configuration_invalid'
  )
  expect(native.createRequire).not.toHaveBeenCalled()
})

it('rejects a relative root before loading the addon', () => {
  enable()
  expect(() => admission.initializeProfileLifetimeAdmission('relative-profile')).toThrow(
    'configuration_invalid'
  )
  expect(native.createRequire).not.toHaveBeenCalled()
})

it('refuses late opt-in after legacy work and does not allow clearing the flag to bypass it', () => {
  admission.assertProfileLifetimeAdmission()
  enable()
  expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow('too_late')
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('too_late')
  expect(native.binding.acquire).not.toHaveBeenCalled()
})

it('reuses ownership for the same physical root including a directory alias', () => {
  enable()
  admission.initializeProfileLifetimeAdmission(profile)
  const alias = join(directory, 'alias')
  symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir')
  admission.initializeProfileLifetimeAdmission(profile)
  admission.initializeProfileLifetimeAdmission(alias)
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  admission.assertProfileLifetimeAdmission()
  expect(native.binding.acquire).toHaveBeenCalledOnce()
  expect(native.createRequire).toHaveBeenCalledOnce()
  expect(native.binding.release).not.toHaveBeenCalled()
})

it('refuses another physical root without acquiring a second lock', () => {
  enable()
  admission.initializeProfileLifetimeAdmission(profile)
  const other = join(directory, 'other')
  mkdirSync(other)
  expect(() => admission.initializeProfileLifetimeAdmission(other)).toThrow('root_changed')
  expect(native.binding.acquire).toHaveBeenCalledOnce()
  expect(native.binding.release).not.toHaveBeenCalled()
})

it('latches identity drift even after the original physical directory is restored', () => {
  enable()
  admission.initializeProfileLifetimeAdmission(profile)
  const retained = join(directory, 'retained-profile')
  renameSync(profile, retained)
  mkdirSync(profile)
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('identity_changed')
  rmSync(profile, { recursive: true })
  renameSync(retained, profile)
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('identity_changed')
  expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow('identity_changed')
  expect(native.binding.release).not.toHaveBeenCalled()
})

it.each(['load', 'acquire', 'assertCurrent'] as const)(
  'latches a native %s failure across flag changes and retries',
  (operation) => {
    enable()
    const error = new Error(`native_${operation}_failed`)
    const fail = () => {
      throw error
    }
    if (operation === 'load') {
      native.load.mockImplementationOnce(fail)
    } else {
      native.binding[operation].mockImplementationOnce(fail)
    }
    expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow(error)
    vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
    expect(() => admission.assertProfileLifetimeAdmission()).toThrow(error)
    enable()
    expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow(error)
    expect(native.load).toHaveBeenCalledOnce()
  }
)

it('latches a native identity failure after successful admission without releasing ownership', () => {
  enable()
  admission.initializeProfileLifetimeAdmission(profile)
  native.binding.assertCurrent.mockImplementationOnce(() => {
    throw new Error('native_identity_changed')
  })
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('native_identity_changed')
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow('native_identity_changed')
  expect(native.binding.release).not.toHaveBeenCalled()
})

it('exposes no early-release API or ownership handle', () => {
  enable()
  expect(Object.keys(admission).sort()).toEqual([
    'assertProfileLifetimeAdmission',
    'initializeProfileLifetimeAdmission',
    'readCurrentProfileLifetimeParticipation'
  ])
  expect(admission.initializeProfileLifetimeAdmission(profile)).toBeUndefined()
  expect(admission.assertProfileLifetimeAdmission()).toBeUndefined()
  expect(native.binding.release).not.toHaveBeenCalled()
})

it.each([undefined, null, false, 0])('latches a falsy native failure %s', (value) => {
  enable()
  native.load.mockImplementationOnce(() => {
    throw value
  })
  expect(() => admission.initializeProfileLifetimeAdmission(profile)).toThrow(String(value))
  vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', undefined)
  expect(() => admission.assertProfileLifetimeAdmission()).toThrow(String(value))
  expect(native.load).toHaveBeenCalledOnce()
})

import { mkdtempSync, mkdirSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireProfileLifetimeLock } from './profile-lifetime-lock'

let directory: string
let profile: string
const token = {}
const binding = { acquire: vi.fn(() => token), assertCurrent: vi.fn(), release: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  binding.acquire.mockReturnValue(token)
  directory = mkdtempSync(join(tmpdir(), 'orca-profile-lock-unit-'))
  profile = join(directory, 'profile')
  mkdirSync(profile)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('retains the physical-profile lock until resource retirement is established', () => {
  const lock = acquireProfileLifetimeLock(profile, binding)
  expect(binding.acquire).toHaveBeenCalledWith(
    join(realpathSync.native(profile), 'profile-lifetime.lock')
  )
  expect(() =>
    lock.release(() => {
      throw new Error('resources_unverifiable')
    })
  ).toThrow('resources_unverifiable')
  expect(binding.release).not.toHaveBeenCalled()
  lock.assertCurrent()
  const retired = vi.fn()
  lock.release(retired)
  expect(retired).toHaveBeenCalledOnce()
  expect(binding.release).toHaveBeenCalledExactlyOnceWith(token)
  expect(() => lock.assertCurrent()).toThrow('released')
  lock.release(retired)
  expect(retired).toHaveBeenCalledOnce()
})

it('keeps failed native release unverifiable without retrying', () => {
  const lock = acquireProfileLifetimeLock(profile, binding)
  binding.release.mockImplementationOnce(() => {
    throw new Error('close_failed')
  })
  expect(() => lock.release(() => {})).toThrow('close_failed')
  expect(() => lock.assertCurrent()).toThrow('release_unverifiable')
  expect(() => lock.release(() => {})).toThrow('release_unverifiable')
  expect(binding.release).toHaveBeenCalledOnce()
})

it('rejects asynchronous retirement proof before releasing the native lock', () => {
  const lock = acquireProfileLifetimeLock(profile, binding)
  // Runtime protection also covers untyped callers.
  const retire = (() => Promise.resolve()) as unknown as () => undefined
  expect(() => lock.release(retire)).toThrow('retirement_must_be_synchronous')
  expect(binding.release).not.toHaveBeenCalled()
  lock.assertCurrent()
  lock.release(() => {})
  expect(binding.release).toHaveBeenCalledOnce()
})

it('refuses same-path profile replacement even if the native lock still reports current', () => {
  const lock = acquireProfileLifetimeLock(profile, binding)
  renameSync(profile, join(directory, 'retained-profile'))
  mkdirSync(profile)
  expect(() => lock.assertCurrent()).toThrow('identity_changed')
  expect(binding.release).not.toHaveBeenCalled()
  lock.release(() => {})
})

it('cleans a lock whose initial identity validation fails before work admission', () => {
  binding.assertCurrent.mockImplementation(() => {
    throw new Error('identity_changed')
  })
  expect(() => acquireProfileLifetimeLock(profile, binding)).toThrow('identity_changed')
  expect(binding.release).toHaveBeenCalledExactlyOnceWith(token)
})

it('preserves initialization and cleanup failures together', () => {
  binding.assertCurrent.mockImplementation(() => {
    throw new Error('identity_changed')
  })
  binding.release.mockImplementation(() => {
    throw new Error('close_failed')
  })
  expect(() => acquireProfileLifetimeLock(profile, binding)).toThrow(AggregateError)
})

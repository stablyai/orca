import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureProfileLifetimeParticipation,
  parseProfileLifetimeParticipation,
  type ProfileLifetimeParticipation
} from './profile-lifetime-participation'

let directory: string
let root: string
let lock: string
let incarnation: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-profile-participation-unit-'))
  root = join(directory, 'profile')
  lock = join(root, 'profile-lifetime.lock')
  incarnation = randomUUID()
  mkdirSync(root)
  writeFileSync(lock, '')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function record() {
  return captureProfileLifetimeParticipation(root, incarnation, () => {})
}

function filesystemIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true })
  return { device: String(stat.dev), inode: String(stat.ino), birth: String(stat.birthtimeNs) }
}

it('captures the exact root and lock identities between two authority assertions', () => {
  unlinkSync(lock)
  let expectedLock: ReturnType<typeof filesystemIdentity> | undefined
  const authority = vi
    .fn<() => void>()
    .mockImplementationOnce(() => {
      writeFileSync(lock, '')
      expectedLock = filesystemIdentity(lock)
    })
    .mockImplementationOnce(() => unlinkSync(lock))
  const captured = captureProfileLifetimeParticipation(root, incarnation, authority)
  expect(authority).toHaveBeenCalledTimes(2)
  expect(captured).toEqual({
    version: 1,
    kind: 'process-held-root-lock',
    processIncarnation: incarnation,
    physicalRoot: root,
    root: filesystemIdentity(root),
    lock: expectedLock
  })
  expect(Object.isFrozen(captured)).toBe(true)
  expect(Object.isFrozen(captured.root)).toBe(true)
  expect(Object.isFrozen(captured.lock)).toBe(true)
  expect(Reflect.set(captured, 'physicalRoot', directory)).toBe(false)
  expect(Reflect.set(captured.root, 'inode', '1')).toBe(false)
  expect(Reflect.set(captured.lock, 'birth', '0')).toBe(false)
})

it('fails before filesystem access when initial authority is unavailable', () => {
  const authority = vi.fn(() => {
    throw new Error('authority unavailable')
  })
  expect(() =>
    captureProfileLifetimeParticipation(join(directory, 'absent'), incarnation, authority)
  ).toThrow('authority unavailable')
  expect(authority).toHaveBeenCalledOnce()
})

it('does not publish captured evidence when the final authority assertion fails', () => {
  const authority = vi
    .fn<() => void>()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('authority changed during capture')
    })
  expect(() => captureProfileLifetimeParticipation(root, incarnation, authority)).toThrow(
    'authority changed during capture'
  )
  expect(authority).toHaveBeenCalledTimes(2)
})

it('parses a detached deeply frozen record without retaining mutable input identities', () => {
  const input = structuredClone(record())
  const parsed = parseProfileLifetimeParticipation(input)
  input.physicalRoot = directory
  input.root.inode = '1'
  input.lock.birth = '0'
  expect(parsed).toEqual(record())
  expect(parsed.root).not.toBe(input.root)
  expect(parsed.lock).not.toBe(input.lock)
  expect(Object.isFrozen(parsed)).toBe(true)
  expect(Object.isFrozen(parsed.root)).toBe(true)
  expect(Object.isFrozen(parsed.lock)).toBe(true)
})

it.each([
  ['unknown top-level field', (value: ProfileLifetimeParticipation) => ({ ...value, extra: true })],
  [
    'unknown root field',
    (value: ProfileLifetimeParticipation) => ({ ...value, root: { ...value.root, extra: true } })
  ],
  [
    'unknown lock field',
    (value: ProfileLifetimeParticipation) => ({ ...value, lock: { ...value.lock, extra: true } })
  ],
  ['wrong version', (value: ProfileLifetimeParticipation) => ({ ...value, version: 2 })],
  ['wrong kind', (value: ProfileLifetimeParticipation) => ({ ...value, kind: 'sqlite-lock' })],
  [
    'invalid incarnation',
    (value: ProfileLifetimeParticipation) => ({ ...value, processIncarnation: 'not-a-uuid' })
  ],
  [
    'relative root',
    (value: ProfileLifetimeParticipation) => ({ ...value, physicalRoot: 'relative/profile' })
  ],
  [
    'NUL root',
    (value: ProfileLifetimeParticipation) => ({
      ...value,
      physicalRoot: `${value.physicalRoot}\0suffix`
    })
  ],
  ['empty root', (value: ProfileLifetimeParticipation) => ({ ...value, physicalRoot: '' })],
  [
    'oversized root',
    (value: ProfileLifetimeParticipation) => ({
      ...value,
      physicalRoot: join(directory, 'x'.repeat(32769))
    })
  ],
  ['missing lock', (value: ProfileLifetimeParticipation) => ({ ...value, lock: undefined })],
  ['null root identity', (value: ProfileLifetimeParticipation) => ({ ...value, root: null })]
] as const)('rejects %s', (_label, invalid) => {
  expect(() => parseProfileLifetimeParticipation(invalid(record()))).toThrow()
})

it.each(['root', 'lock'] as const)(
  'strictly validates every %s filesystem identity field',
  (part) => {
    const valid = record()
    for (const field of ['device', 'inode', 'birth'] as const) {
      for (const value of ['', '-1', '1.5', '1\0', 'x', '1'.repeat(33), 1, null, undefined]) {
        expect(() =>
          parseProfileLifetimeParticipation({
            ...valid,
            [part]: { ...valid[part], [field]: value }
          })
        ).toThrow()
      }
    }
    for (const inode of ['0', '01']) {
      expect(() =>
        parseProfileLifetimeParticipation({ ...valid, [part]: { ...valid[part], inode } })
      ).toThrow()
    }
  }
)

it('rejects a directory at the lock pathname', () => {
  unlinkSync(lock)
  mkdirSync(lock)
  expect(record).toThrow('identity_unavailable')
})

it('rejects a directory symlink or junction at the lock pathname', () => {
  unlinkSync(lock)
  const target = join(directory, 'other')
  mkdirSync(target)
  symlinkSync(target, lock, process.platform === 'win32' ? 'junction' : 'dir')
  expect(record).toThrow('identity_unavailable')
})

it('rejects a regular file where a profile directory is required', () => {
  expect(() => captureProfileLifetimeParticipation(lock, incarnation, () => {})).toThrow(
    'identity_unavailable'
  )
})

it.skipIf(process.platform === 'win32')('rejects a symlink to an otherwise valid lock file', () => {
  unlinkSync(lock)
  const target = join(directory, 'other.lock')
  writeFileSync(target, '')
  symlinkSync(target, lock, 'file')
  expect(record).toThrow('identity_unavailable')
})

it('rejects a profile alias instead of recording a nonphysical root', () => {
  const alias = join(directory, 'alias')
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => captureProfileLifetimeParticipation(alias, incarnation, () => {})).toThrow(
    'identity_unavailable'
  )
})

it('refuses missing lock evidence', () => {
  unlinkSync(lock)
  expect(record).toThrow()
})

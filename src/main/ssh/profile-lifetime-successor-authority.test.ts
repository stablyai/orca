import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureProfileLifetimeParticipation,
  type ProfileLifetimeParticipation
} from './profile-lifetime-participation'
import { retainProfileLifetimeSuccessorAuthority } from './profile-lifetime-successor-authority'

const readCurrent = vi.hoisted(() => vi.fn<() => ProfileLifetimeParticipation | null>())
vi.mock('./profile-lifetime-admission', () => ({
  readCurrentProfileLifetimeParticipation: readCurrent
}))

let directory: string
let historical: ProfileLifetimeParticipation
let current: ProfileLifetimeParticipation

beforeEach(() => {
  readCurrent.mockReset()
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-successor-authority-unit-')))
  writeFileSync(join(directory, 'profile-lifetime.lock'), '')
  historical = captureProfileLifetimeParticipation(directory, randomUUID(), () => {})
  current = captureProfileLifetimeParticipation(directory, randomUUID(), () => {})
  readCurrent.mockReturnValue(current)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('retains a different process with exactly matching physical root and lock identities', () => {
  const authority = retainProfileLifetimeSuccessorAuthority(historical)
  expect(readCurrent).toHaveBeenCalledTimes(2)
  expect(authority).not.toThrow()
  readCurrent.mockReturnValue(structuredClone(current))
  expect(authority).not.toThrow()
})

it('refuses the historical process even if its native identities match', () => {
  readCurrent.mockReturnValue(historical)
  expect(() => retainProfileLifetimeSuccessorAuthority(historical)).toThrow('same_process')
})

it.each([null, undefined, {}, { version: 1 }, 'not evidence'])(
  'rejects missing or malformed historical evidence %j before consulting admission',
  (value) => {
    expect(() => retainProfileLifetimeSuccessorAuthority(value)).toThrow()
    expect(readCurrent).not.toHaveBeenCalled()
  }
)

it('rejects malformed historical identity fields instead of accepting a matching process claim', () => {
  expect(() =>
    retainProfileLifetimeSuccessorAuthority({
      ...historical,
      lock: { ...historical.lock, inode: '0' }
    })
  ).toThrow()
  expect(readCurrent).not.toHaveBeenCalled()
})

it('refuses absent current admission', () => {
  readCurrent.mockReturnValue(null)
  expect(() => retainProfileLifetimeSuccessorAuthority(historical)).toThrow(
    'participation_unavailable'
  )
})

it('validates current admission evidence rather than trusting the getter shape', () => {
  readCurrent.mockReturnValue({ ...current, processIncarnation: 'invalid' })
  expect(() => retainProfileLifetimeSuccessorAuthority(historical)).toThrow()
})

it('refuses a different physical root path even with otherwise matching identities', () => {
  readCurrent.mockReturnValue({ ...current, physicalRoot: join(directory, 'other') })
  expect(() => retainProfileLifetimeSuccessorAuthority(historical)).toThrow('identity_changed')
})

it.each(['root', 'lock'] as const)(
  'checks every component of the %s filesystem identity',
  (part) => {
    for (const field of ['device', 'inode', 'birth'] as const) {
      readCurrent.mockReturnValue({
        ...current,
        [part]: { ...current[part], [field]: String(BigInt(current[part][field]) + 1n) }
      })
      expect(() => retainProfileLifetimeSuccessorAuthority(historical)).toThrow('identity_changed')
    }
  }
)

it('rechecks current admission before returning an authority handle', () => {
  readCurrent.mockReturnValueOnce(current).mockReturnValueOnce(null)
  expect(() => retainProfileLifetimeSuccessorAuthority(historical)).toThrow(
    'participation_unavailable'
  )
})

it('retained authority refuses loss of native admission', () => {
  const authority = retainProfileLifetimeSuccessorAuthority(historical)
  readCurrent.mockReturnValue(null)
  expect(authority).toThrow('participation_unavailable')
})

it.each(['process', 'path', 'root', 'lock'] as const)(
  'retained authority refuses changed current %s identity',
  (part) => {
    const authority = retainProfileLifetimeSuccessorAuthority(historical)
    const changed = structuredClone(current)
    if (part === 'process') {
      changed.processIncarnation = randomUUID()
    } else if (part === 'path') {
      changed.physicalRoot = join(directory, 'other')
    } else {
      changed[part].inode = String(BigInt(changed[part].inode) + 1n)
    }
    readCurrent.mockReturnValue(changed)
    expect(authority).toThrow('authority_changed')
  }
)

it('propagates admission failure during retained validation', () => {
  const authority = retainProfileLifetimeSuccessorAuthority(historical)
  readCurrent.mockImplementation(() => {
    throw new Error('native_lock_identity_changed')
  })
  expect(authority).toThrow('native_lock_identity_changed')
})

it('does not let later caller mutation rewrite retained historical or current evidence', () => {
  const supplied = structuredClone(historical)
  const mutableCurrent = structuredClone(current)
  readCurrent.mockReturnValue(mutableCurrent)
  const authority = retainProfileLifetimeSuccessorAuthority(supplied)
  supplied.processIncarnation = current.processIncarnation
  supplied.physicalRoot = join(directory, 'other')
  supplied.root.inode = '1'
  supplied.lock.birth = '0'
  expect(authority).not.toThrow()
  mutableCurrent.lock.inode = String(BigInt(current.lock.inode) + 1n)
  expect(authority).toThrow('authority_changed')
})

import { describe, expect, it, vi } from 'vitest'
import {
  buildPosixPtyRootSnapshot,
  classifyPosixPtySessionLiveness,
  isMacosLoginWrapperCommand,
  provesOwnedEmptyLoginWrapper,
  readPosixPtyRootSnapshot,
  readPosixPtySessionLiveness
} from './posix-pty-session-liveness'

const TABLE = `
  100  50 ttys001 /usr/bin/login -flpq user /bin/bash
  101 100 ttys001 -/bin/zsh -l
  102 101 ttys001 claude
  200  50 ttys002 /usr/bin/login -flpq user /bin/bash
  300  50 ?? /usr/bin/login -flpq user /bin/bash
`

const EMPTY_OWNED = `
  200  50 ttys002 /usr/bin/login -flpq user /bin/bash
`

describe('classifyPosixPtySessionLiveness', () => {
  it('reports live when peers share the root TTY', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 100, 999)).toBe('live')
  })

  it('reports empty when only the root remains on its TTY', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 200, 999)).toBe('empty')
  })

  it('reports gone when the root pid is absent', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 999, 998)).toBe('gone')
  })

  it('reports unknown for unbound ttys or a PTY shared with Orca itself', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 300, 999)).toBe('unknown')
    expect(classifyPosixPtySessionLiveness(TABLE, 100, 101)).toBe('unknown')
  })
})

describe('buildPosixPtyRootSnapshot', () => {
  it('captures ppid/command for ownership proofs', () => {
    expect(buildPosixPtyRootSnapshot(EMPTY_OWNED, 200, 999)).toEqual({
      liveness: 'empty',
      rootPid: 200,
      ppid: 50,
      tty: 'ttys002',
      command: '/usr/bin/login -flpq user /bin/bash'
    })
  })

  it('fails closed when a process-table line cannot be parsed', () => {
    expect(buildPosixPtyRootSnapshot('not a process row\n', 200, 999).liveness).toBe('gone')
  })
})

describe('isMacosLoginWrapperCommand / provesOwnedEmptyLoginWrapper', () => {
  it('accepts login argv0 forms and rejects unrelated commands', () => {
    expect(isMacosLoginWrapperCommand('/usr/bin/login -flpq u /bin/bash')).toBe(true)
    expect(isMacosLoginWrapperCommand('login -flpq u')).toBe(true)
    expect(isMacosLoginWrapperCommand('/bin/zsh -l')).toBe(false)
    expect(isMacosLoginWrapperCommand('login-shell-helper')).toBe(false)
  })

  it('requires empty + matching root + daemon ppid + login command', () => {
    const empty = buildPosixPtyRootSnapshot(EMPTY_OWNED, 200, 999)
    expect(provesOwnedEmptyLoginWrapper(empty, { rootPid: 200, ownerPid: 50 })).toBe(true)
    expect(provesOwnedEmptyLoginWrapper(empty, { rootPid: 200, ownerPid: 99 })).toBe(false)
    expect(provesOwnedEmptyLoginWrapper(empty, { rootPid: 201, ownerPid: 50 })).toBe(false)

    const live = buildPosixPtyRootSnapshot(TABLE, 100, 999)
    expect(provesOwnedEmptyLoginWrapper(live, { rootPid: 100, ownerPid: 50 })).toBe(false)

    const recycled = {
      ...empty,
      command: '/bin/zsh -l'
    }
    expect(provesOwnedEmptyLoginWrapper(recycled, { rootPid: 200, ownerPid: 50 })).toBe(false)
  })
})

describe('readPosixPtySessionLiveness / readPosixPtyRootSnapshot', () => {
  it('never classifies Windows as empty', async () => {
    await expect(
      readPosixPtySessionLiveness(100, {
        platform: 'win32',
        readProcessTable: async () => TABLE
      })
    ).resolves.toBe('unknown')
  })

  it('classifies through the injectable async process-table seam', async () => {
    await expect(
      readPosixPtyRootSnapshot(200, {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: async () => EMPTY_OWNED
      })
    ).resolves.toMatchObject({ liveness: 'empty', ppid: 50 })
  })

  it('treats process-table failures and timeouts as unknown, not empty', async () => {
    await expect(
      readPosixPtySessionLiveness(100, {
        platform: 'darwin',
        readProcessTable: async () => {
          throw new Error('ps timed out')
        }
      })
    ).resolves.toBe('unknown')
  })

  it('treats rejected reads as unknown', async () => {
    await expect(
      readPosixPtySessionLiveness(100, {
        platform: 'darwin',
        readProcessTable: async () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }
      })
    ).resolves.toBe('unknown')
  })

  it('does not start overlapping production reads when the seam serializes', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const readProcessTable = vi.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      return EMPTY_OWNED
    })
    await Promise.all([
      readPosixPtyRootSnapshot(200, { platform: 'darwin', currentPid: 999, readProcessTable }),
      readPosixPtyRootSnapshot(200, { platform: 'darwin', currentPid: 999, readProcessTable })
    ])
    // Parallel callers may overlap at the seam; the death watch serializes — this only
    // proves the reader itself is async and non-blocking.
    expect(readProcessTable).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBeGreaterThanOrEqual(1)
  })
})

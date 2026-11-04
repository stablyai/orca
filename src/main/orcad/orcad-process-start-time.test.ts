import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DaemonProcessStartTime from '../daemon/daemon-process-start-time'

const { readWindowsProcessCreationTime, getProcessStartedAtMs } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>(),
  getProcessStartedAtMs: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessCreationTime
}))
vi.mock('../daemon/daemon-process-start-time', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonProcessStartTime>()),
  getProcessStartedAtMs
}))

import {
  compareOrcadProcessIdentity,
  readOrcadProcessIncarnation,
  readOrcadProcessName,
  readOrcadProcessOwnerUid,
  readOrcadProcessStartedAtMs
} from './orcad-process-start-time'

const platform = process.platform
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  onPlatform(platform)
  vi.resetAllMocks()
})

describe('orcad process start time', () => {
  it('reads the addon creation time on Windows, never the POSIX probe', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(1_700_000_000_123)
    expect(readOrcadProcessStartedAtMs(42)).toBe(1_700_000_000_123)
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(42)
    expect(getProcessStartedAtMs).not.toHaveBeenCalled()
  })

  it('keeps the POSIX probe elsewhere', () => {
    onPlatform('linux')
    getProcessStartedAtMs.mockReturnValue(5_000)
    expect(readOrcadProcessStartedAtMs(42)).toBe(5_000)
    expect(readWindowsProcessCreationTime).not.toHaveBeenCalled()
  })

  it('tells a reused Windows PID apart, and fails open when the addon cannot answer', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(9_000_000)
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 1_000 })).toBe('differs')
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 9_000_100 })).toBe('matches')
    readWindowsProcessCreationTime.mockReturnValue(null)
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 1_000 })).toBe('unknown')
  })
})

describe('orcad process identity', () => {
  const incarnation = { linuxStartTicks: '1234', bootId: 'boot-a' }
  const recorded = { startedAtMs: 1_000, ...incarnation }

  it('matches on ticks and boot id even when the btime-derived start time drifted', () => {
    expect(
      compareOrcadProcessIdentity(42, recorded, {
        startedAtMs: () => 158_000,
        incarnation: () => incarnation,
        platform: 'linux'
      })
    ).toBe('matches')
  })

  it.each([
    ['different start ticks', { ...incarnation, linuxStartTicks: '9999' }],
    ['a different boot', { ...incarnation, bootId: 'boot-b' }]
  ])('proves reuse on %s', (_name, actual) => {
    expect(compareOrcadProcessIdentity(42, recorded, { incarnation: () => actual })).toBe('differs')
  })

  it('is unknown, never different, when the incarnation cannot be read', () => {
    expect(compareOrcadProcessIdentity(42, recorded, { incarnation: () => null })).toBe('unknown')
  })

  it('reads a Linux wall-clock mismatch on a record without ticks as unproven', () => {
    expect(
      compareOrcadProcessIdentity(
        42,
        { startedAtMs: 1_000 },
        {
          startedAtMs: () => 158_000,
          incarnation: () => incarnation,
          platform: 'linux'
        }
      )
    ).toBe('unproven')
  })

  it.each([
    ['another non-root uid', 1001, 'differs'],
    ['root', 0, 'unproven'],
    ['the overflow uid an unmapped root shows as', 65534, 'unproven'],
    ['the same uid', 1000, 'unproven'],
    ['an unreadable owner', null, 'unproven']
  ] as const)('reads that mismatch with the PID owned by %s as %s', (_owner, ownerUid, verdict) => {
    const readers = {
      startedAtMs: () => 158_000,
      ownerUid: () => ownerUid,
      platform: 'linux' as const
    }
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 1_000, identity: '1000' }, readers)).toBe(
      verdict
    )
  })

  it('never proves reuse by owner when the recorded identity is not a uid', () => {
    expect(
      compareOrcadProcessIdentity(
        42,
        { startedAtMs: 1_000, identity: 'alice' },
        { startedAtMs: () => 158_000, ownerUid: () => 1001, platform: 'linux' }
      )
    ).toBe('unproven')
  })
})

describe.runIf(platform === 'linux')('orcad process incarnation on a real /proc', () => {
  it('reads ticks and the boot id, even for a command name with spaces and parens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-incarnation-'))
    const odd = join(dir, 'x) y (z')
    symlinkSync('/bin/sleep', odd)
    const child = spawn(odd, ['30'], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid ?? 0
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const own = readOrcadProcessIncarnation(process.pid)
      const other = readOrcadProcessIncarnation(pid)
      expect(own).toEqual({
        linuxStartTicks: expect.stringMatching(/^\d+$/),
        bootId
      })
      expect(other).toEqual({
        linuxStartTicks: expect.stringMatching(/^\d+$/),
        bootId
      })
      expect(compareOrcadProcessIdentity(pid, { startedAtMs: null, ...other })).toBe('matches')
      expect(compareOrcadProcessIdentity(pid, { startedAtMs: null, ...own })).toBe('differs')
    } finally {
      child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a PID that does not exist', () => {
    expect(readOrcadProcessIncarnation(2 ** 30)).toBeNull()
    expect(readOrcadProcessOwnerUid(2 ** 30)).toBeNull()
    expect(readOrcadProcessName(2 ** 30)).toBeNull()
  })

  it('reads its own owner uid and command name', () => {
    expect(readOrcadProcessOwnerUid(process.pid)).toBe(process.getuid?.())
    expect(readOrcadProcessName(process.pid)).toMatch(/^[\x20-\x7e]+$/)
  })
})

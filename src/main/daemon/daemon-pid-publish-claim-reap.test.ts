import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reapOrphanedDaemonPidPublishClaims } from './daemon-pid-publish-claim-reap'
import { DaemonSpawner, getDaemonPidPublishClaimPath } from './daemon-spawner'

const CLAIM_UUID = '01234567-89ab-cdef-0123-456789abcdef'

let dir: string

function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''])
  expect(result.status).toBe(0)
  expect(result.pid).toBeGreaterThan(0)
  return result.pid as number
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-pid-reap-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reapOrphanedDaemonPidPublishClaims', () => {
  it('reaps a claim whose owner is proven dead, for current and retired protocol versions', () => {
    const pid = deadPid()
    const current = join(dir, `daemon-v7.pid.publish-${pid}-${CLAIM_UUID}`)
    const retired = join(dir, `daemon-v3.pid.publish-${pid}-${CLAIM_UUID}`)
    writeFileSync(current, '{"pid":1')
    writeFileSync(retired, '{"pid":1')

    reapOrphanedDaemonPidPublishClaims(dir)

    expect(existsSync(current)).toBe(false)
    expect(existsSync(retired)).toBe(false)
  })

  it('never reaps a claim owned by a live process, or by this process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    try {
      const livePid = child.pid as number
      expect(livePid).toBeGreaterThan(0)
      const liveClaim = join(dir, `daemon-v7.pid.publish-${livePid}-${CLAIM_UUID}`)
      const ownClaim = join(dir, `daemon-v7.pid.publish-${process.pid}-${CLAIM_UUID}`)
      writeFileSync(liveClaim, '{"pid":1')
      writeFileSync(ownClaim, '{"pid":1')

      reapOrphanedDaemonPidPublishClaims(dir)

      expect(existsSync(liveClaim)).toBe(true)
      expect(existsSync(ownClaim)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('touches nothing but publish scratch — records, tokens, and swap/hold claims stay', () => {
    const pid = deadPid()
    const untouchable = [
      'daemon-v7.pid',
      'daemon-v7.token',
      `daemon-v7.pid.swap-${pid}-${CLAIM_UUID}`,
      `daemon-v7.token.hold-${pid}-${CLAIM_UUID}`
    ].map((name) => join(dir, name))
    for (const path of untouchable) {
      writeFileSync(path, 'keep')
    }

    reapOrphanedDaemonPidPublishClaims(dir)

    for (const path of untouchable) {
      expect(existsSync(path)).toBe(true)
    }
  })

  it('keeps a claim whose owner exists under another user', () => {
    // Why EPERM is not death: `kill(pid, 0)` reports EPERM for a live process owned by
    // another user (a root-launched daemon, a shared machine). Reaping on any errno
    // would delete a LIVE publisher's claim between its write and its link, knocking
    // that publish off the atomic path onto the non-atomic degraded write.
    const foreign = join(dir, `daemon-v7.pid.publish-424242-${CLAIM_UUID}`)
    writeFileSync(foreign, '{"pid":1')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    try {
      reapOrphanedDaemonPidPublishClaims(dir)
    } finally {
      kill.mockRestore()
    }

    expect(existsSync(foreign)).toBe(true)
  })

  it('keeps a claim whose owner is live but unsignalable on Windows', () => {
    // Why a second errno: Windows reports a live foreign owner as EACCES, not the POSIX
    // EPERM above (isPermissionError in win32-utils treats both as one). Only ESRCH reaps.
    const foreign = join(dir, `daemon-v7.pid.publish-424242-${CLAIM_UUID}`)
    writeFileSync(foreign, '{"pid":1')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    try {
      reapOrphanedDaemonPidPublishClaims(dir)
    } finally {
      kill.mockRestore()
    }

    expect(existsSync(foreign)).toBe(true)
  })

  it('never lets an unremovable claim abort the sweep or the launch', () => {
    // Why: reaping is hygiene on the launch funnel, so any failure here — a Windows file
    // lock, a permission error, a stray directory under a claim name — must not escape
    // into ensureRunning and stop the daemon from starting.
    const pid = deadPid()
    const unremovable = join(dir, `daemon-v7.pid.publish-${pid}-${CLAIM_UUID}`)
    mkdirSync(unremovable)
    writeFileSync(join(unremovable, 'occupant'), 'x')
    const removable = join(dir, `daemon-v9.pid.publish-${pid}-${CLAIM_UUID}`)
    writeFileSync(removable, '{"pid":1')

    expect(() => reapOrphanedDaemonPidPublishClaims(dir)).not.toThrow()

    expect(existsSync(removable)).toBe(false)
  })

  it('tolerates a missing runtime dir', () => {
    expect(() => reapOrphanedDaemonPidPublishClaims(join(dir, 'absent'))).not.toThrow()
  })

  it('runs on the launch funnel: ensureRunning clears a dead publisher’s claim', async () => {
    const orphan = join(dir, `daemon-v7.pid.publish-${deadPid()}-${CLAIM_UUID}`)
    writeFileSync(orphan, '{"pid":1')
    const spawner = new DaemonSpawner({
      runtimeDir: dir,
      launcher: async () => ({ shutdown: async () => {} })
    })

    await spawner.ensureRunning()

    expect(existsSync(orphan)).toBe(false)
    await spawner.shutdown()
  })
})

describe('getDaemonPidPublishClaimPath', () => {
  it('generates names the orphan reap recognizes once their owner dies', () => {
    // Pin the generator and the reaper to the same shape: a drift here is a silent
    // permanent leak of every crash-orphaned claim.
    const generated = getDaemonPidPublishClaimPath(join(dir, 'daemon-v7.pid'))
    const orphan = generated.replace(`.publish-${process.pid}-`, `.publish-${deadPid()}-`)
    expect(orphan).not.toBe(generated)
    writeFileSync(orphan, '{"pid":1')

    reapOrphanedDaemonPidPublishClaims(dir)

    expect(existsSync(orphan)).toBe(false)
  })
})

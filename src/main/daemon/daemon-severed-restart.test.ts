import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./daemon-provider-restart', () => ({ restartDaemon: vi.fn() }))

import {
  clearSeveredDaemon,
  getSeveredDaemon,
  installSeveredDaemonController,
  noteSeveredDaemon,
  readSeveredDaemonStatus,
  restartSeveredDaemon
} from './daemon-host-image-state'
import type { DaemonHostImageInspection } from './daemon-host-image'
import {
  createSeveredDaemonController,
  hasSeveredDaemonBeenReplaced
} from './daemon-severed-restart'

const SEVERED: DaemonHostImageInspection = {
  verdict: 'severed',
  pid: 4288,
  linuxStartTicks: '777',
  bootId: 'boot-1'
}
const EXPECTED = { pid: 4288, linuxStartTicks: '777', bootId: 'boot-1' }

function setUp(
  current: DaemonHostImageInspection,
  sessions = [{ isAlive: true }],
  fallbackSessions = 0
) {
  const restart = vi.fn(async (_expectedPid: number) => ({ killedCount: sessions.length }))
  installSeveredDaemonController(
    createSeveredDaemonController({
      inspect: () => current,
      restart,
      listSessions: async () => sessions,
      countFallbackSessions: () => fallbackSessions
    })
  )
  noteSeveredDaemon(SEVERED)
  return restart
}

afterEach(() => {
  clearSeveredDaemon()
})

describe('restarting a daemon whose AppImage files are gone', () => {
  it('counts every running terminal a restart would end, local fallback included', async () => {
    setUp(SEVERED, [{ isAlive: true }, { isAlive: false }, { isAlive: true }], 2)
    await expect(readSeveredDaemonStatus()).resolves.toEqual({ ...EXPECTED, liveSessionCount: 4 })
  })

  it('restarts only the incarnation the caller saw, after re-reading it', async () => {
    const restart = setUp(SEVERED)
    await expect(restartSeveredDaemon(EXPECTED)).resolves.toEqual({
      status: 'restarted',
      killedCount: 1
    })
    // The pid travels into the restart so its teardown re-checks the endpoint owner.
    expect(restart).toHaveBeenCalledWith(4288)
    expect(getSeveredDaemon()).toBeNull()
  })

  it('refuses when the caller saw another incarnation', async () => {
    const restart = setUp(SEVERED)
    await expect(restartSeveredDaemon({ ...EXPECTED, linuxStartTicks: '1' })).resolves.toEqual({
      status: 'refused',
      reason: 'replaced'
    })
    expect(restart).not.toHaveBeenCalled()
  })

  it('refuses when the host now names a different daemon', async () => {
    const restart = setUp({ ...SEVERED, verdict: 'intact', pid: 9000, linuxStartTicks: '5' })
    await expect(restartSeveredDaemon(EXPECTED)).resolves.toEqual({
      status: 'refused',
      reason: 'replaced'
    })
    expect(restart).not.toHaveBeenCalled()
  })

  it('refuses without killing when the process cannot be verified', async () => {
    const restart = setUp({ ...SEVERED, verdict: 'unknown' })
    await expect(restartSeveredDaemon(EXPECTED)).resolves.toEqual({
      status: 'refused',
      reason: 'unverifiable'
    })
    expect(restart).not.toHaveBeenCalled()
    expect(getSeveredDaemon()).toEqual(EXPECTED)
  })

  it('reports nothing severed until a daemon was kept severed', async () => {
    setUp(SEVERED)
    clearSeveredDaemon()
    await expect(readSeveredDaemonStatus()).resolves.toBeNull()
    await expect(restartSeveredDaemon(EXPECTED)).resolves.toEqual({
      status: 'refused',
      reason: 'not-severed'
    })
  })
})

describe('hasSeveredDaemonBeenReplaced', () => {
  it('keeps the quarantine while the severed incarnation still owns the endpoint', () => {
    setUp(SEVERED)
    expect(hasSeveredDaemonBeenReplaced('/pid', () => SEVERED)).toBe(false)
    expect(hasSeveredDaemonBeenReplaced('/pid', () => ({ ...SEVERED, verdict: 'unknown' }))).toBe(
      false
    )
    expect(getSeveredDaemon()).toEqual(EXPECTED)
  })

  it('lifts it once a verified, intact daemon replaced the severed one', () => {
    setUp(SEVERED)
    expect(
      hasSeveredDaemonBeenReplaced('/pid', () => ({
        verdict: 'intact',
        pid: 9000,
        linuxStartTicks: '5',
        bootId: 'boot-1'
      }))
    ).toBe(true)
    expect(getSeveredDaemon()).toBeNull()
  })
})

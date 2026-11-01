import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./daemon-provider-restart', () => ({ restartDaemon: vi.fn() }))

import {
  clearSeveredDaemon,
  getSeveredDaemon,
  installSeveredDaemonController,
  noteSeveredDaemon,
  restartSeveredDaemon
} from './daemon-host-image-state'

import type { DaemonHostImageInspection } from './daemon-host-image'
import { createSeveredDaemonController } from './daemon-severed-restart'

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
})

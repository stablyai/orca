import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureOrcadManagedStopInstance,
  captureOrcadManagedStopIdentity,
  startOrcadProfileDaemon
} from './orcad-profile-daemon-startup'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { loadOrCreateRuntimeIdentity } from '../runtime/runtime-identity'
import { PtyOwnershipTransferAdmissionRecord } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-admission-record'

const start = vi.hoisted(() => vi.fn(async () => ({ state: 'live' })))
vi.mock('./orcad-daemon-supervision', () => ({ startOrcadDaemon: start }))
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-profile-daemon-'))
  start.mockClear()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it.each([false, true])(
  'selects startup from the exact profile marker (closed=%s)',
  async (closed) => {
    const identity = loadOrCreateRuntimeIdentity(join(directory, 'runtime-identity.json'))
    if (closed) {
      new PtyOwnershipTransferAdmissionRecord(directory, identity).close()
    }
    expect(await startOrcadProfileDaemon(directory)).toBe(identity)
    expect(start).toHaveBeenCalledWith({ recoveryOnly: closed })
  }
)

it('captures the physical startup profile without following later profile-index changes', () => {
  const profile = { profile: { id: 'profile-a' }, profileDirectory: directory }
  const identity = captureOrcadManagedStopIdentity('runtime-a', profile)
  expect(identity).toEqual({
    runtimeId: 'runtime-a',
    profileId: 'profile-a',
    profileRoot: realpathSync(directory)
  })
  expect(Object.isFrozen(identity)).toBe(true)
  profile.profile.id = 'profile-b'
  profile.profileDirectory = join(directory, 'other')
  expect(identity.profileId).toBe('profile-a')
  expect(identity.profileRoot).toBe(realpathSync(directory))
})

it('captures the instance from the actual data-root lock, not a slot PID file', () => {
  const lock = acquireOrcadInstanceLock(directory)
  try {
    const instance = captureOrcadManagedStopInstance(lock)
    expect(instance).toEqual({
      pid: process.pid,
      startedAtMs: lock.record.startedAtMs,
      nonce: lock.record.nonce,
      lockPath: realpathSync(lock.path)
    })
    expect(Object.isFrozen(instance)).toBe(true)
  } finally {
    lock.release()
  }
})

it('does not let another profile stop marker fence an independent host', async () => {
  const identity = loadOrCreateRuntimeIdentity(join(directory, 'runtime-identity.json'))
  new PtyOwnershipTransferAdmissionRecord(directory, identity).close()
  await startOrcadProfileDaemon(join(directory, 'independent'))
  expect(start).toHaveBeenCalledWith({ recoveryOnly: false })
})

it.each(['{', '{"version":1,"runtimeId":"wrong-host","state":"closed"}'])(
  'rejects unverifiable marker authority before daemon startup (%#)',
  async (record) => {
    writeFileSync(join(directory, 'pty-ownership-transfer-admission.json'), record)
    await expect(startOrcadProfileDaemon(directory)).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
  }
)

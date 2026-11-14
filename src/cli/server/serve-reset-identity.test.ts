import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resetServeHostIdentity } from './serve-reset-identity'
import { loadOrCreateE2EEKeypair } from '../../main/runtime/rpc/server/pairing/e2ee-keypair'
import { DeviceRegistry } from '../../main/runtime/rpc/server/pairing/device-registry'
import {
  acquireOrcadInstanceLock,
  ORCAD_LOCK_FILE_NAME
} from '../../main/orcad/instance-lock/orcad-instance-lock'
import {
  ensureHostInstanceIdentity,
  hostInstanceIdFromEnv
} from '../../main/runtime/host-instance-identity'

function pairedProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reset-identity-'))
  chmodSync(dir, 0o700)
  const registry = new DeviceRegistry(dir)
  const { token } = registry.addDevice('Phone')
  return { dir, token, publicKeyB64: loadOrCreateE2EEKeypair(dir).publicKeyB64 }
}

describe('resetServeHostIdentity', () => {
  it('rotates the key and removes paired devices, then stays put across restarts', async () => {
    const before = pairedProfile()
    await resetServeHostIdentity(before.dir)

    const publicKeyB64 = loadOrCreateE2EEKeypair(before.dir).publicKeyB64
    expect(publicKeyB64).not.toBe(before.publicKeyB64)
    expect(new DeviceRegistry(before.dir).validateToken(before.token)).toBeNull()
    expect(ensureHostInstanceIdentity(before.dir, null)).toEqual({ kind: 'unchanged' })
    // A variable adopted after the reset is only recorded.
    expect(
      ensureHostInstanceIdentity(before.dir, hostInstanceIdFromEnv({ ORCA_INSTANCE_ID: 'vm-a' }))
    ).toEqual({ kind: 'recorded' })
    expect(loadOrCreateE2EEKeypair(before.dir).publicKeyB64).toBe(publicKeyB64)
  })

  it('keeps the notice that the last run crashed, and leaves no lock after a clean one', async () => {
    const before = pairedProfile()
    const lockPath = join(before.dir, ORCAD_LOCK_FILE_NAME)
    await resetServeHostIdentity(before.dir)
    expect(existsSync(lockPath)).toBe(false)

    // What an orcad killed before releasing its lock leaves behind; the pid is past any pid_max.
    const crashed = acquireOrcadInstanceLock(before.dir)
    crashed.release()
    writeFileSync(lockPath, JSON.stringify({ ...crashed.record, pid: 99_999_999 }))
    await resetServeHostIdentity(before.dir)

    const next = acquireOrcadInstanceLock(before.dir)
    try {
      expect(next.previousUnexpectedExit).toMatchObject({ pid: 99_999_999 })
    } finally {
      next.release()
    }
  })

  it('refuses while an Orca holds the profile lock and changes nothing', async () => {
    const before = pairedProfile()
    const lock = acquireOrcadInstanceLock(before.dir)
    try {
      await expect(resetServeHostIdentity(before.dir)).rejects.toThrow(/Stop Orca/)
    } finally {
      lock.release()
    }
    expect(loadOrCreateE2EEKeypair(before.dir).publicKeyB64).toBe(before.publicKeyB64)
    expect(new DeviceRegistry(before.dir).validateToken(before.token)).not.toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'leaves desktop profile permissions alone when it refuses because the desktop app runs',
    async () => {
      const before = pairedProfile()
      chmodSync(before.dir, 0o755)
      const lock = acquireOrcadInstanceLock(before.dir, { role: 'desktop' })
      try {
        await expect(resetServeHostIdentity(before.dir)).rejects.toThrow(/Stop Orca/)
      } finally {
        lock.release()
      }
      expect(statSync(before.dir).mode & 0o777).toBe(0o755)
      expect(loadOrCreateE2EEKeypair(before.dir).publicKeyB64).toBe(before.publicKeyB64)
    }
  )
})

import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  resolveEnvironmentPairingOffer
} from './environments'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

describe('CLI runtime environments', () => {
  const posixModeIt = process.platform === 'win32' ? it.skip : it

  it('saves, resolves, and removes a paired environment', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
    const saved = addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode(),
      now: 100
    })

    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation')).toMatchObject({
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token'
    })
    expect(resolveEnvironmentPairingOffer(userDataPath, saved.id)).toMatchObject({
      endpoint: 'ws://127.0.0.1:6768'
    })
    expect(statSync(getEnvironmentStorePath(userDataPath)).isFile()).toBe(true)

    const removed = removeEnvironment(userDataPath, 'workstation')
    expect(removed.id).toBe(saved.id)
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  posixModeIt('stores paired environments with owner-only POSIX permissions', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))

    addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode(),
      now: 100
    })

    // Why: NTFS mode bits do not prove Windows ACL hardening; shared secure-file
    // tests cover that path, while POSIX hosts must keep the token store at 0600.
    expect((statSync(getEnvironmentStorePath(userDataPath)).mode & 0o777).toString(8)).toBe('600')
  })

  it('rejects an environment with the same name', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode('ws://127.0.0.1:1111'),
      now: 100
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation',
        pairingCode: pairingCode('ws://127.0.0.1:2222'),
        now: 200
      })
    ).toThrow('A server named "workstation" already exists.')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation').endpoint).toBe(
      'ws://127.0.0.1:1111'
    )
    expect(listEnvironments(userDataPath)[0]?.id).toBe(first.id)
  })
})

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  resolveEnvironmentPairingOffer
} from './environments'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-env-store-'))
  roots.push(root)
  return root
}

function pairingCode(endpoint = 'ws://127.0.0.1:6768', keyFill = 1): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyFill)).toString('base64')
  })
}

describe('CLI runtime environments', () => {
  const posixModeIt = process.platform === 'win32' ? it.skip : it

  it('saves, resolves, and removes a paired environment', () => {
    const userDataPath = temporaryProfile()
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
    const userDataPath = temporaryProfile()

    addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode(),
      now: 100
    })

    // POSIX mode bits cannot prove Windows ACL hardening; secure-file tests cover it.
    expect((statSync(getEnvironmentStorePath(userDataPath)).mode & 0o777).toString(8)).toBe('600')
  })

  it('rejects an environment with the same name', () => {
    const userDataPath = temporaryProfile()
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode('ws://127.0.0.1:1111'),
      now: 100
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation',
        pairingCode: pairingCode('ws://127.0.0.1:2222', 2),
        now: 200
      })
    ).toThrow('A server named "workstation" already exists.')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(resolveEnvironmentPairingOffer(userDataPath, 'workstation').endpoint).toBe(
      'ws://127.0.0.1:1111'
    )
    expect(listEnvironments(userDataPath)[0]?.id).toBe(first.id)
  })

  it('refuses saving the same server twice and points at Settings, which can switch its connection', () => {
    const userDataPath = temporaryProfile()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'workstation',
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 100
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'workstation over relay',
        pairingCode: pairingCode('ws://198.51.100.7:6768'),
        now: 200
      })
    ).toThrow('already paired as "workstation"')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })
})

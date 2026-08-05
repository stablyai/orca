import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getHostProfilePublicationRevision,
  publishHostProfileTransaction,
  resetHostProfilePublicationForTests,
  retireHostProfilePublication
} from './host-profile-publication'

const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'key',
  deviceToken: 'token-1',
  lastConnected: 0
}

describe('user pairing host publication', () => {
  beforeEach(() => resetHostProfilePublicationForTests())

  it('supersedes a background recovery that commits first', async () => {
    let releaseRecovery: (() => void) | null = null
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const writes: string[] = []
    const recovery = publishHostProfileTransaction(
      HOST,
      () => recoveryGate,
      async () => {
        writes.push('recovery')
      }
    )
    const pairing = publishHostProfileTransaction(
      { ...HOST, deviceToken: 'token-2' },
      null,
      async () => {
        writes.push('pairing')
      },
      'adopt-current'
    )

    releaseRecovery?.()

    await expect(recovery).resolves.toBeUndefined()
    await expect(pairing).resolves.toBeUndefined()
    expect(writes).toEqual(['recovery', 'pairing'])
    expect(getHostProfilePublicationRevision(HOST.id)).toBe(2)
  })

  it('does not let user pairing resurrect a retired host', async () => {
    let releaseRecovery: (() => void) | null = null
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const recovery = publishHostProfileTransaction(HOST, () => recoveryGate, vi.fn())
    const pairing = publishHostProfileTransaction(
      { ...HOST, deviceToken: 'token-2' },
      null,
      vi.fn(),
      'adopt-current'
    )

    retireHostProfilePublication(HOST.id)
    releaseRecovery?.()

    await expect(recovery).rejects.toThrow('host profile publication was retired')
    await expect(pairing).rejects.toThrow('host profile publication was retired')
  })

  it('keeps a background recovery fenced behind a newer user pairing', async () => {
    let releasePairing: (() => void) | null = null
    const pairingGate = new Promise<void>((resolve) => {
      releasePairing = resolve
    })
    const pairing = publishHostProfileTransaction(
      { ...HOST, deviceToken: 'token-2' },
      () => pairingGate,
      vi.fn(),
      'adopt-current'
    )
    const capturedRevision = getHostProfilePublicationRevision(HOST.id)
    const recoveryWrite = vi.fn()
    const recovery = publishHostProfileTransaction(HOST, null, recoveryWrite, capturedRevision)

    releasePairing?.()

    await expect(pairing).resolves.toBeUndefined()
    await expect(recovery).rejects.toThrow('host profile publication was retired')
    expect(recoveryWrite).not.toHaveBeenCalled()
  })
})

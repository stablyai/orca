import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import {
  isEndedClientPairing,
  recordEndedClientPairings,
  registerPairedDeviceCredentials,
  reviveClientPairing
} from './client-ask-ended-pairings'

const ENVIRONMENT = 'client:device_a/install_a'

describe("whether a paired computer's conversation can still take a reply", () => {
  let dir: string
  let db: OrchestrationDb
  let owner: Pick<OrcaRuntimeService, 'getOrchestrationDb'>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-client-ask-ended-'))
    db = new OrchestrationDb(join(dir, 'server.db'))
    owner = { getOrchestrationDb: () => db }
    for (const fingerprint of ['fp_a', 'fp_b']) {
      db.openHomePeerMailConversation({
        environmentId: ENVIRONMENT,
        peerFingerprint: fingerprint,
        localParty: 'term_s',
        localPaneKey: null
      })
    }
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const ended = (pairing: string) =>
    isEndedClientPairing(owner, db, { environmentId: ENVIRONMENT, deviceId: 'device_a', pairing })

  it('ends only the pairing a re-pair names, until that pairing pulls again', () => {
    recordEndedClientPairings(db, ENVIRONMENT, { only: 'fp_a' })

    expect(ended('fp_a')).toBe(true)
    expect(ended('fp_b')).toBe(false)
    reviveClientPairing(db, ENVIRONMENT, 'fp_a')
    expect(ended('fp_a')).toBe(false)
  })

  it('ends a pairing whose device is gone or holds another credential, with nothing recorded', () => {
    // No registry to tell: only what is recorded counts.
    registerPairedDeviceCredentials(owner, () => undefined)
    expect(ended('fp_a')).toBe(false)
    const devices = new Map([['device_a', 'fp_b']])
    registerPairedDeviceCredentials(owner, (deviceId) => devices.get(deviceId) ?? null)

    expect(ended('fp_a')).toBe(true)
    expect(ended('fp_b')).toBe(false)
    devices.delete('device_a')
    expect(ended('fp_b')).toBe(true)
  })
})

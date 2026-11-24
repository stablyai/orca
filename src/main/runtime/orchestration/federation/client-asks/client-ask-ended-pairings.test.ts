import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import {
  isEndedClientPairing,
  listUnsettledClientPairings,
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
    recordEndedClientPairings(
      db,
      ENVIRONMENT,
      { only: 'fp_a' },
      { serverName: 'Laptop', reason: 'x' }
    )

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

  it('opens a database an earlier build of the ended table left, keeping its ends, settled', () => {
    db.db.exec(`DROP INDEX idx_ended_client_pairings_unsettled;
      DROP TABLE ended_client_pairings;
      CREATE TABLE ended_client_pairings (
        environment_id TEXT NOT NULL,
        peer_fingerprint TEXT NOT NULL,
        ended_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (environment_id, peer_fingerprint)
      );
      INSERT INTO ended_client_pairings (environment_id, peer_fingerprint) VALUES ('${ENVIRONMENT}', 'fp_a');`)
    db.close()

    // Opened twice, as on two starts.
    db = new OrchestrationDb(join(dir, 'server.db'))
    db.close()
    db = new OrchestrationDb(join(dir, 'server.db'))
    owner = { getOrchestrationDb: () => db }

    expect(ended('fp_a')).toBe(true)
    expect(ended('fp_b')).toBe(false)
    expect(listUnsettledClientPairings(db)).toEqual([])
    recordEndedClientPairings(
      db,
      ENVIRONMENT,
      { only: 'fp_b' },
      { serverName: 'Laptop', reason: 'x' }
    )
    expect(listUnsettledClientPairings(db).map((row) => row.pairing)).toEqual(['fp_b'])
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import { recordPeerQuestionOut } from '../peer-mail/peer-questions-out'
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

  /** The ended table as an earlier build kept it, with an end for each pairing; `partly` as an
   *  upgrade that stopped after adding the sender and reason. */
  function earlierTable(partly = false) {
    db.db.exec(`DROP INDEX idx_ended_client_pairings_unsettled;
      DROP TABLE ended_client_pairings;
      CREATE TABLE ended_client_pairings (
        environment_id TEXT NOT NULL,
        peer_fingerprint TEXT NOT NULL,
        ended_at TEXT NOT NULL DEFAULT (datetime('now')),
        ${partly ? "server_name TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT ''," : ''}
        PRIMARY KEY (environment_id, peer_fingerprint)
      );
      INSERT INTO ended_client_pairings (environment_id, peer_fingerprint)
        VALUES ('${ENVIRONMENT}', 'fp_a'), ('${ENVIRONMENT}', 'fp_b');`)
    // An ask under fp_b still awaits an answer: that end was never settled.
    recordPeerQuestionOut(db, {
      messageId: 'msg_waiting',
      conversationId: String(
        db.db
          .prepare(
            "SELECT conversation_id FROM peer_mail_conversations WHERE peer_fingerprint = 'fp_b'"
          )
          .get()!.conversation_id
      ),
      environmentId: ENVIRONMENT,
      peerFingerprint: 'fp_b',
      asker: 'term_s'
    })
    db.close()
  }

  function reopen() {
    db = new OrchestrationDb(join(dir, 'server.db'))
    owner = { getOrchestrationDb: () => db }
  }

  for (const partly of [false, true]) {
    it(`opens an earlier build's ended table${partly ? ' after an upgrade that stopped part way' : ''}, keeping what it still owes to finish`, () => {
      earlierTable(partly)

      // Opened twice, as on two starts.
      reopen()
      db.close()
      reopen()

      expect(ended('fp_a')).toBe(true)
      expect(ended('fp_b')).toBe(true)
      expect(listUnsettledClientPairings(db)).toEqual([
        {
          environmentId: ENVIRONMENT,
          pairing: 'fp_b',
          serverName: 'A paired computer',
          reason: 'Its pairing with this Orca ended.'
        }
      ])
    })
  }
})

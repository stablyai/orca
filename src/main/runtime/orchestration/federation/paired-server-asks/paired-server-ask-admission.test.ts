import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import {
  dropPairedServerAsk,
  getPairedServerAsk,
  holdPairedServerAsk,
  type PairedServerAskRow
} from '../../db/federation/paired-server-asks-store'
import { heldAskPairing, stillAdmits } from './paired-server-ask-admission'

describe('what admitting a held ask from a paired server checks', () => {
  let dir: string
  let db: OrchestrationDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-paired-server-admission-'))
    db = new OrchestrationDb(join(dir, 'computer.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const open = (conversationId: string, role: 'peer' | 'home') =>
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, ?, 'fingerprint_a', 'env_s')`
      )
      .run(conversationId, role)

  function held(conversationId: string): PairedServerAskRow {
    holdPairedServerAsk(db, {
      message_id: `m_${conversationId}`,
      conversation_id: conversationId,
      server_key: 'fingerprint_s',
      environment_id: 'env_s',
      root_session: 'orca_session_id:asker',
      bot_id: 'docs',
      payload: '{}',
      state: 'admit'
    })
    return getPairedServerAsk(db, `m_${conversationId}`)!
  }

  it("names no pairing for a row kept under anything but a reverse conversation's id", () => {
    open('peerconv_0000000000a1', 'peer')
    open('ctx_0000000000a2', 'peer')
    open('peerconv_0000000000a3', 'home')

    expect(heldAskPairing(db, held('peerconv_0000000000a1'))).toBe('fingerprint_a')
    expect(heldAskPairing(db, held('ctx_0000000000a2'))).toBeUndefined()
    expect(heldAskPairing(db, held('peerconv_0000000000a3'))).toBeUndefined()
  })

  it('admits at commit only to the approved bot, and only while the ask still waits', () => {
    open('peerconv_0000000000b1', 'peer')
    const row = held('peerconv_0000000000b1')

    expect(stillAdmits(db, row, 'docs')).toBe(true)
    // A name lookup that landed on another bot.
    expect(stillAdmits(db, row, 'other')).toBe(false)
    // The row was replaced since it was read: approved for another bot now.
    db.db
      .prepare("UPDATE paired_server_asks SET bot_id = 'other' WHERE message_id = ?")
      .run(row.message_id)
    expect(stillAdmits(db, row, 'docs')).toBe(false)
    dropPairedServerAsk(db, row.message_id)
    expect(stillAdmits(db, row, 'docs')).toBe(false)
  })
})

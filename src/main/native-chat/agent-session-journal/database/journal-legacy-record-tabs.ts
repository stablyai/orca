import { isAgentSessionId } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { isAgentSessionSurfaceTabId } from '../../../../shared/agent-session/view/agent-session-surface-tab-id'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { isReadableAgentSessionStoreTab } from '../../../runtime/agent-session/records/agent-session-store-row-rules'
import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'

export function validateLegacyAgentSessionTabs(
  stage: Database.Database,
  generation: string
): boolean {
  stage.exec(`CREATE TABLE IF NOT EXISTS validated_tabs (
    generation TEXT NOT NULL,
    position INTEGER NOT NULL,
    tab_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY(generation,position),
    UNIQUE(generation,tab_id),
    UNIQUE(generation,session_id)
  )`)
  const add = stage.prepare('INSERT INTO validated_tabs VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
  return runJournalTransaction(stage, () => {
    for (const { key, body } of stage
      .prepare(`SELECT key,body FROM legacy_rows
      WHERE generation=? AND section='sessionTabs' ORDER BY rowid`)
      .iterate(generation)) {
      const entry: unknown = JSON.parse(String(body))
      if (
        !isReadableAgentSessionStoreTab(entry) ||
        !add.run(generation, Number(key), entry.tabId, entry.sessionId).changes
      ) {
        stage.prepare('DELETE FROM validated_tabs WHERE generation=?').run(generation)
        return false
      }
    }
    return true
  })
}

/** Pre-index files hold the tab on the final conversation under its /clear chain's first id. */
export function assignLegacyVisibleTabs(stage: Database.Database, generation: string): void {
  runJournalTransaction(stage, () => {
    stage.exec(`
      CREATE TABLE visible_tabs (session_id TEXT PRIMARY KEY, position INTEGER NOT NULL, tab_id TEXT UNIQUE);
      CREATE TABLE clear_predecessors (successor TEXT PRIMARY KEY, predecessor TEXT UNIQUE);
    `)
    stage
      .prepare(`INSERT INTO clear_predecessors
      SELECT json_extract(body,'$.conversationCommand.replacementSessionId'), key
      FROM legacy_rows WHERE generation=? AND section='records' AND readable=1
        AND json_extract(body,'$.conversationCommand.command')='clear'
        AND json_extract(body,'$.conversationCommand.phase')='committed'
        AND json_extract(body,'$.conversationCommand.replacementSessionId') IS NOT NULL
      ORDER BY rowid ON CONFLICT(successor) DO NOTHING`)
      .run(generation)
    const add = stage.prepare(`INSERT INTO visible_tabs(session_id,position) VALUES(?,?)
      ON CONFLICT(session_id) DO NOTHING`)
    for (const { key, body } of stage
      .prepare(`SELECT key,body FROM legacy_rows
      WHERE generation=? AND section='visibleSessionIds' ORDER BY rowid`)
      .iterate(generation)) {
      const id: unknown = JSON.parse(String(body))
      if (isAgentSessionId(id)) {
        add.run(id, Number(key))
      }
    }
    const held = stage.prepare('SELECT 1 FROM visible_tabs WHERE tab_id=?')
    const surface = stage.prepare(`SELECT json_extract(body,'$.surfaceTabId') AS id FROM legacy_rows
      WHERE generation=? AND section='records' AND key=? AND readable=1`)
    const assign = stage.prepare('UPDATE visible_tabs SET tab_id=? WHERE session_id=?')
    const candidates = (id: string): string[] =>
      [surface.get(generation, id)?.id, structuredAgentSessionTabId(id)].filter(
        isAgentSessionSurfaceTabId
      )
    const assignTab = (id: string, choices: string[]) => {
      let tabId = choices.find((choice) => !held.get(choice))
      if (tabId === undefined) {
        const base = `${structuredAgentSessionTabId(id)}-reopened`
        tabId = base
        for (let suffix = 2; held.get(tabId); suffix += 1) {
          tabId = `${base}-${suffix}`
        }
      }
      assign.run(tabId, id)
    }
    const root = stage.prepare(`WITH RECURSIVE chain(id) AS (
      VALUES(?) UNION ALL SELECT p.predecessor FROM clear_predecessors p JOIN chain ON p.successor=chain.id
    ) SELECT id FROM chain WHERE NOT EXISTS(SELECT 1 FROM clear_predecessors p WHERE p.successor=chain.id)`)
    // Only chain ends can keep an earlier id. Each predecessor has one successor, so a cycle
    // cannot reach a chain end.
    for (const { session_id } of stage
      .prepare(`SELECT v.session_id FROM visible_tabs v
      JOIN clear_predecessors p ON p.successor=v.session_id
      WHERE NOT EXISTS(SELECT 1 FROM clear_predecessors c WHERE c.predecessor=v.session_id)
      ORDER BY v.position`)
      .iterate()) {
      const id = String(session_id)
      const first = root.get(id)?.id
      if (typeof first === 'string') {
        assignTab(id, [...candidates(first), ...candidates(id)])
      }
    }
    for (const { session_id } of stage
      .prepare('SELECT session_id FROM visible_tabs WHERE tab_id IS NULL ORDER BY position')
      .iterate()) {
      const id = String(session_id)
      assignTab(id, candidates(id))
    }
  })
}

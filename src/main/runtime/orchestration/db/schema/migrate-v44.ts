import type { OrchestrationDb } from '../orchestration-db'

/**
 * v44: group-chat rooms. Rooms hold a small roster (`room_members`), an append-only
 * transcript (`room_log`) and a per-member read cursor (`room_members.seen_seq`).
 * Messages between members still go through `messages`; the room tables own the
 * ordering and the read cursors the round runner needs.
 */
export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  this.db.exec(ROOM_SCHEMA_SQL)
}

export const ROOM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'admin' CHECK(mode IN ('admin','everyone')),
  admin_member_id  TEXT,
  notice           TEXT NOT NULL DEFAULT '',
  worktree         TEXT NOT NULL DEFAULT '',
  seq              INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name_lower ON rooms(lower(name));

CREATE TABLE IF NOT EXISTS room_members (
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  seen_seq    INTEGER NOT NULL DEFAULT 0,
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_room_name
  ON room_members(room_id, name);

CREATE TABLE IF NOT EXISTS room_log (
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  who         TEXT NOT NULL,
  member_id   TEXT,
  text        TEXT NOT NULL,
  kind        TEXT,
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, seq)
);
`

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHistorySessionDirName } from '../../../daemon/history-paths'
import type { SessionMeta } from '../../../daemon/terminal-history-metadata'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'

export type StoredScrollbackSessionSeed = {
  historyDir: string
  worktreeId: string
  tabId: string
  leafId: string
  ref: string
  scrollback: string
  cwd: string
}

/**
 * A terminal session id whose history starts as a moved pane's stored scrollback, so the pane's next
 * start cold-restores it like any interrupted session. A moved pane keeps its history only as a
 * stored snapshot, which no paired client's mirrored layout names; the session is what they attach to.
 *
 * The id is the pane's own: a later start finds the same folder, now holding what the pane printed
 * since (or a clean exit), and is never handed the stale snapshot again.
 */
export function seedSessionFromStoredScrollback(seed: StoredScrollbackSessionSeed): string {
  const suffix = createHash('sha256')
    .update(`${seed.tabId}\0${seed.leafId}\0${seed.ref}`)
    .digest('hex')
    .slice(0, 8)
  const sessionId = `${seed.worktreeId}${PTY_SESSION_ID_SEPARATOR}${suffix}`
  const dir = join(seed.historyDir, getHistorySessionDirName(sessionId))
  const metaPath = join(dir, 'meta.json')
  if (existsSync(metaPath)) {
    return sessionId
  }
  // Why: a seed a crash cut short left no meta.json, so it is not a session yet; redo it whole.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const meta: SessionMeta = {
    cwd: seed.cwd,
    cols: 80,
    rows: 24,
    startedAt: new Date().toISOString(),
    // Why null: only a session that never ended cold-restores; this one never ran here at all.
    endedAt: null,
    exitCode: null
  }
  writeFileSync(join(dir, 'scrollback.bin'), seed.scrollback, { mode: 0o600 })
  // Why last and renamed: meta is what makes the folder a session, so it appears only once complete.
  writeFileSync(`${metaPath}.tmp`, JSON.stringify(meta), { mode: 0o600 })
  renameSync(`${metaPath}.tmp`, metaPath)
  return sessionId
}

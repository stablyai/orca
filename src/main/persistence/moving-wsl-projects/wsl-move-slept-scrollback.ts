/**
 * A slept pane's scrollback lives only in the daemon's checkpoint, never in a renderer snapshot, so
 * a WSL move reads it right after its Sleep and carries it on the snapshot channel under the pane's
 * own ref. Each buffer is spooled to a file, so only hashes and sizes stay in memory.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WslMoveRequest } from '../../../shared/wsl-move/wsl-move-driver-types'
import { parsePtySessionId } from '../../../shared/pty-session-id-format'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import type { OrcadMigrationSnapshotSource } from '../../ssh/orcad-migration-snapshot-coordinator'
import {
  decodeFromFirstUtf8Boundary,
  makeTerminalScrollbackSnapshotRef
} from '../../terminal-scrollback-snapshots'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import type { ColdRestoreReader, WslMoveRestoreHintPane } from './wsl-move-restore-hints'

export type WslMoveSleptBuffer = { path: string; sha256: string; byteLength: number }

export type WslMoveSleptScrollback = {
  /** Keyed `tabId:leafId`. */
  buffers: ReadonlyMap<string, WslMoveSleptBuffer>
  /** User-facing: panes whose latest history can't be read. The move refuses rather than drop it. */
  problems: readonly string[]
  /** Removes the spooled files; the move calls it whatever its outcome. */
  dispose: () => void
}

const SPOOL_DIR = 'wsl-move-slept-scrollback'

export function emptyWslMoveSleptScrollback(): WslMoveSleptScrollback {
  return { buffers: new Map(), problems: [], dispose: () => {} }
}

/** Never throws: an unreadable reader is a problem the move reports, not a crash. */
export async function readSleptScrollback(
  deps: Pick<WslMoveDriverDeps, 'sleptScrollback'>,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string,
  migrationId: string,
  workspaceIds: readonly string[],
  reported: readonly WslMoveRestoreHintPane[] = []
): Promise<WslMoveSleptScrollback> {
  if (!deps.sleptScrollback) {
    return emptyWslMoveSleptScrollback()
  }
  return deps
    .sleptScrollback(panes, distro, migrationId, workspaceIds, reported)
    .catch((error: unknown) => {
      console.warn('[wsl-move] Slept terminal history unreadable:', error)
      return {
        ...emptyWslMoveSleptScrollback(),
        problems: ['saved terminal history Orca could not read']
      }
    })
}

/** For the preview: what a start would refuse for panes slept already, said before the user starts. */
export async function unreadableSleptHistory(
  deps: Pick<WslMoveDriverDeps, 'sleptScrollback'>,
  request: Pick<WslMoveRequest, 'distro' | 'sleptPanes'>,
  migrationId: string,
  workspaceIds: readonly string[]
): Promise<string[]> {
  const slept = await readSleptScrollback(
    deps,
    [],
    request.distro,
    migrationId,
    workspaceIds,
    request.sleptPanes
  )
  slept.dispose()
  return [...slept.problems]
}

/** For the export: a slept pane's buffer, read from its spool file only while it is hashed. */
export function sleptScrollbackReader(
  slept: WslMoveSleptScrollback
): ((tabId: string, leafId: string) => Buffer | null) | undefined {
  if (slept.buffers.size === 0) {
    return undefined
  }
  return (tabId, leafId) => {
    const entry = slept.buffers.get(`${tabId}:${leafId}`)
    return entry ? readFileSync(entry.path) : null
  }
}

/**
 * Production reader: each pane's checkpoint as cold restore would replay it (scrollback, then the
 * screen), kept to the newest bytes one stored snapshot holds. Sleep ends a session cleanly, which
 * is exactly why its clean end is not a reason to skip the checkpoint here.
 */
export async function readWslMoveSleptScrollbackFromHistory(
  reader: ColdRestoreReader,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string,
  spoolRoot: string,
  /** What the tab bar calls it; an id means nothing to the user. */
  tabTitle: (tabId: string) => string | null = () => null
): Promise<WslMoveSleptScrollback> {
  const buffers = new Map<string, WslMoveSleptBuffer>()
  const problems: string[] = []
  const noCheckpoint: string[] = []
  const dispose = (): void => rmSync(spoolRoot, { recursive: true, force: true })
  try {
    mkdirSync(spoolRoot, { recursive: true, mode: 0o700 })
    for (const [index, pane] of panes.entries()) {
      const leaf = parsePaneKey(pane.paneKey)
      if (!leaf) {
        continue
      }
      const detection = await reader
        .detectColdRestoreState(pane.sessionId, { ignoreCleanEnd: true, wslDistro: distro })
        .catch(() => ({ status: 'unreadable' as const, sessionId: pane.sessionId }))
      if (detection.status === 'none') {
        noCheckpoint.push(leaf.tabId)
        continue
      }
      // A checkpoint behind an unreadable log is older than the pane: moving it would lose the rest.
      if (detection.status === 'unreadable' || detection.hasUnreadableRecovery) {
        const title = tabTitle(leaf.tabId)
        problems.push(
          `saved terminal history Orca could not fully read for the tab ${title ? `"${title}"` : leaf.tabId}`
        )
        continue
      }
      const { scrollbackAnsi, snapshotAnsi } = detection.restoreInfo
      // awin verify-5: an open pane carried 140 B after 3,000 lines; say where each pane's bytes came from.
      console.info(
        `[wsl-move] Slept pane ${leaf.tabId}: scrollback ${scrollbackAnsi.length} chars, screen ` +
          `${snapshotAnsi.length} chars, cwd ${detection.restoreInfo.cwd ? 'set' : 'none'}` +
          `${detection.cwdFromSpawn ? ' (spawn folder)' : ''}`
      )
      // Cold restore fills scrollbackAnsi from snapshotAnsi for a normal screen, so both hold the
      // whole buffer; on the alternate screen scrollbackAnsi is the normal buffer behind the TUI.
      const buffer = detection.restoreInfo.modes?.alternateScreen
        ? scrollbackAnsi || snapshotAnsi
        : snapshotAnsi || scrollbackAnsi
      const bytes = capped(Buffer.from(buffer, 'utf8'))
      if (bytes.length === 0) {
        continue
      }
      const path = join(spoolRoot, `${index}.bin`)
      writeFileSync(path, bytes, { mode: 0o600 })
      buffers.set(`${leaf.tabId}:${leaf.leafId}`, {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length
      })
    }
  } catch (error) {
    dispose()
    throw error
  }
  // The awin run moved panes empty with no trace of why: say what each pane had.
  console.info(
    `[wsl-move] Slept terminal history: ${buffers.size} carried, ${problems.length} unreadable, ` +
      `${noCheckpoint.length} with no checkpoint${noCheckpoint.length > 0 ? ` (${noCheckpoint.join(', ')})` : ''}, ` +
      `of ${panes.length} panes`
  )
  return { buffers, problems, dispose }
}

export function wslMoveSleptSpoolRoot(userDataPath: string, migrationId: string): string {
  return join(userDataPath, SPOOL_DIR, migrationId)
}

function capped(bytes: Buffer): Buffer {
  return bytes.length > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
    ? Buffer.from(
        decodeFromFirstUtf8Boundary(bytes.subarray(-TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT)),
        'utf8'
      )
    : bytes
}

/** The store's snapshot reader, answering a slept pane's ref from its spool file. */
export function withSleptSnapshots(
  source: OrcadMigrationSnapshotSource,
  slept: WslMoveSleptScrollback
): OrcadMigrationSnapshotSource {
  if (slept.buffers.size === 0) {
    return source
  }
  const byRef = new Map<string, WslMoveSleptBuffer>()
  for (const [key, entry] of slept.buffers) {
    const split = key.lastIndexOf(':')
    byRef.set(makeTerminalScrollbackSnapshotRef(key.slice(0, split), key.slice(split + 1)), entry)
  }
  return {
    readOrcadMigrationSourceSnapshotChunk: (manifest, ref, offset) => {
      const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
        (entry) => entry.ref === ref
      )
      const entry = byRef.get(ref)
      // A ref the manifest signed from the store (not this spool) is the store's to serve.
      if (!descriptor || !entry || entry.sha256 !== descriptor.sha256) {
        return source.readOrcadMigrationSourceSnapshotChunk(manifest, ref, offset)
      }
      const length = Math.max(
        0,
        Math.min(ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES, entry.byteLength - offset)
      )
      const chunk = Buffer.alloc(length)
      const fd = openSync(entry.path, 'r')
      try {
        readSync(fd, chunk, 0, length, offset)
      } finally {
        closeSync(fd)
      }
      return {
        bytesBase64: chunk.toString('base64'),
        totalBytes: entry.byteLength,
        eof: offset + length >= entry.byteLength
      }
    }
  }
}

/**
 * Panes the user slept before the move: they have no live terminal for the move to list, but a
 * layout still names the session whose checkpoint holds their history. Main retires a slept pane's
 * binding while the window keeps it for wake, so the window's report counts too; it is trusted
 * only for a leaf of a moved workspace's tab and a session id minted for that workspace.
 */
export function listWslMoveSleptSessionPanes(
  session: WorkspaceSessionState,
  workspaceIds: readonly string[],
  reported: readonly WslMoveRestoreHintPane[] = []
): WslMoveRestoreHintPane[] {
  const panes: WslMoveRestoreHintPane[] = []
  const workspaceByTabId = new Map<string, string>()
  for (const workspaceId of workspaceIds) {
    for (const tab of session.tabsByWorktree[workspaceId] ?? []) {
      workspaceByTabId.set(tab.id, workspaceId)
      const bindings = session.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, sessionId] of Object.entries(bindings)) {
        if (isTerminalLeafId(leafId) && sessionId) {
          panes.push({ paneKey: makePaneKey(tab.id, leafId), sessionId })
        }
      }
    }
  }
  for (const pane of reported) {
    const key = parsePaneKey(pane.paneKey)
    const workspaceId = key ? workspaceByTabId.get(key.tabId) : undefined
    if (
      key &&
      workspaceId &&
      collectLeafIds(session.terminalLayoutsByTabId[key.tabId]?.root).includes(key.leafId) &&
      parsePtySessionId(pane.sessionId).worktreeId === workspaceId
    ) {
      panes.push({ paneKey: pane.paneKey, sessionId: pane.sessionId })
    }
  }
  return withSleptSessionPanes([], panes)
}

/** One pane per key, the first listed kept: live panes first, their session just checkpointed. */
export function withSleptSessionPanes(
  live: readonly WslMoveRestoreHintPane[],
  slept: readonly WslMoveRestoreHintPane[]
): WslMoveRestoreHintPane[] {
  const known = new Set<string>()
  return [...live, ...slept].filter((pane) => {
    if (known.has(pane.paneKey)) {
      return false
    }
    known.add(pane.paneKey)
    return true
  })
}

/** The tab bar's name for a tab of the session, or null for a tab it does not hold. */
export function wslMoveTabTitle(session: WorkspaceSessionState, tabId: string): string | null {
  for (const tabs of Object.values(session.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return tab.customTitle?.trim() || tab.title.trim() || null
    }
  }
  return null
}

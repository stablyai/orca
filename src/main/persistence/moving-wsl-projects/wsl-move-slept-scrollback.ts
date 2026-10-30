/**
 * A paused pane's history lives in the daemon's checkpoint, so a WSL move reads it right after its
 * Sleep and carries it as a `terminal-history` blob (checkpoint, cwd and size) for the host's own
 * daemon to cold-restore once. Each document is spooled to a file; only hashes stay in memory.
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  ORCAD_MIGRATION_TERMINAL_HISTORY_VERSION,
  type OrcadMigrationTerminalHistoryDocument
} from '../../../shared/orcad-migration/orcad-migration-terminal-history'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WslMoveRequest } from '../../../shared/wsl-move/wsl-move-driver-types'
import { parsePtySessionId } from '../../../shared/pty-session-id-format'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import type { ColdRestoreInfo } from '../../daemon/history-reader'
import type { TerminalCheckpointFile } from '../../daemon/types'
import type { OrcadMigrationBlobSource } from '../../ssh/orcad-migration-blob-coordinator'
import { orcadMigrationTerminalHistoryKey } from '../migrating-orcad-catalog/orcad-terminal-history-installer'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import {
  wslMoveHostLinuxCwd,
  type ColdRestoreReader,
  type WslMoveRestoreHintPane
} from './wsl-move-restore-hints'

export type WslMoveSleptBuffer = { path: string; sha256: string; byteLength: number }

export type WslMoveSleptScrollback = {
  /** Each pane's `terminal-history` document, keyed by pane key. */
  buffers: ReadonlyMap<string, WslMoveSleptBuffer>
  /** User-facing: panes whose latest history can't be read. The move refuses rather than drop it. */
  problems: readonly string[]
  /** Removes the spooled files; the move calls it whatever its outcome. */
  dispose: () => void
}

export const WSL_MOVE_SLEPT_SPOOL_DIR = 'wsl-move-slept-scrollback'
const MAX_HISTORY_BYTES = ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['terminal-history'].maxBytes

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

/** For the export: the panes whose history travels as a blob, so no snapshot also paints it. */
export function daemonHistoryLeafOf(
  slept: WslMoveSleptScrollback
): ((tabId: string, leafId: string) => boolean) | undefined {
  if (slept.buffers.size === 0) {
    return undefined
  }
  // Why not makePaneKey: it throws on a non-UUID leaf, which a carried pane never has.
  return (tabId, leafId) => isTerminalLeafId(leafId) && slept.buffers.has(`${tabId}:${leafId}`)
}

/**
 * Each pane's `terminal-history` blob, read from its spool file as the channel asks for it. Only a
 * pane whose layout the manifest moves: the host refuses history for a pane it would not hold.
 */
export function wslMoveTerminalHistoryBlobs(
  slept: WslMoveSleptScrollback,
  manifest: {
    payload: {
      dormantState?: {
        workspaceSession?: Pick<WorkspaceSessionState, 'terminalLayoutsByTabId'> | null
      }
    }
  }
): {
  descriptors: OrcadMigrationBlobDescriptor[]
  source: OrcadMigrationBlobSource
} {
  const byKey = new Map<string, WslMoveSleptBuffer>()
  const descriptors: OrcadMigrationBlobDescriptor[] = []
  const layouts = manifest.payload.dormantState?.workspaceSession?.terminalLayoutsByTabId ?? {}
  for (const [paneKey, entry] of slept.buffers) {
    const pane = parsePaneKey(paneKey)
    if (!pane || !collectLeafIds(layouts[pane.tabId]?.root).includes(pane.leafId)) {
      continue
    }
    const key = orcadMigrationTerminalHistoryKey(paneKey)
    byKey.set(key, entry)
    descriptors.push({
      blobKind: 'terminal-history',
      key,
      sha256: entry.sha256,
      byteLength: entry.byteLength
    })
  }
  return {
    descriptors,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        const entry = byKey.get(requested.key)
        if (!entry || entry.sha256 !== requested.sha256) {
          throw new Error(`orcad_migration_source_blob_changed:${requested.blobKind}`)
        }
        const length = Math.max(0, Math.min(maxBytes, entry.byteLength - offset))
        const chunk = Buffer.alloc(length)
        const fd = openSync(entry.path, 'r')
        try {
          readSync(fd, chunk, 0, length, offset)
        } finally {
          closeSync(fd)
        }
        return chunk
      }
    }
  }
}

/**
 * Production reader: each pane's checkpoint exactly as a cold restore here would replay it, written
 * as the checkpoint the host's daemon restores once. Sleep ends a session cleanly, which is exactly
 * why its clean end is not a reason to skip the checkpoint here.
 */
export async function readWslMoveSleptScrollbackFromHistory(
  reader: ColdRestoreReader,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string,
  spoolRoot: string,
  /** What the tab bar calls it; an id means nothing to the user. */
  tabTitle: (tabId: string) => string | null = () => null,
  now: () => Date = () => new Date()
): Promise<WslMoveSleptScrollback> {
  const buffers = new Map<string, WslMoveSleptBuffer>()
  const problems: string[] = []
  const noCheckpoint: string[] = []
  const dispose = (): void => rmSync(spoolRoot, { recursive: true, force: true })
  const tabName = (tabId: string): string => {
    const title = tabTitle(tabId)
    return title ? `"${title}"` : tabId
  }
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
        problems.push(
          `saved terminal history Orca could not fully read for the tab ${tabName(leaf.tabId)}`
        )
        continue
      }
      const shellCwd = pane.shellCwd && /^\/(?!\/)/.test(pane.shellCwd) ? pane.shellCwd : null
      const cwd = shellCwd ?? wslMoveHostLinuxCwd(detection.restoreInfo.cwd, pane, distro)
      const document: OrcadMigrationTerminalHistoryDocument = {
        version: ORCAD_MIGRATION_TERMINAL_HISTORY_VERSION,
        paneKey: pane.paneKey,
        cwd,
        cols: detection.restoreInfo.cols,
        rows: detection.restoreInfo.rows,
        checkpoint: checkpointOf(detection.restoreInfo, cwd, now())
      }
      const bytes = Buffer.from(JSON.stringify(document), 'utf8')
      if (bytes.length > MAX_HISTORY_BYTES) {
        problems.push(
          `more saved terminal history than one move carries for the tab ${tabName(leaf.tabId)}`
        )
        continue
      }
      const path = join(spoolRoot, `${index}.json`)
      writeFileSync(path, bytes, { mode: 0o600 })
      buffers.set(pane.paneKey, {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length
      })
    }
  } catch (error) {
    dispose()
    throw error
  }
  console.info(
    `[wsl-move] Slept terminal history: ${buffers.size} carried, ${problems.length} unreadable, ` +
      `${noCheckpoint.length} with no checkpoint${noCheckpoint.length > 0 ? ` (${noCheckpoint.join(', ')})` : ''}, ` +
      `of ${panes.length} panes`
  )
  return { buffers, problems, dispose }
}

export function wslMoveSleptSpoolRoot(userDataPath: string, migrationId: string): string {
  return join(userDataPath, WSL_MOVE_SLEPT_SPOOL_DIR, migrationId)
}

// What the daemon's own checkpoint writer would hold for this restore; no log is carried with it.
function checkpointOf(
  info: ColdRestoreInfo,
  cwd: string | null,
  checkpointedAt: Date
): TerminalCheckpointFile {
  // A normal screen's buffer is the snapshot; cold restore refills scrollback from it on read.
  const scrollbackAnsi =
    !info.modes.alternateScreen && info.scrollbackAnsi === info.snapshotAnsi
      ? ''
      : info.scrollbackAnsi
  // Why the line break: the screen ends on the old shell's prompt, and the host's new shell would
  // print its own beside it (`$ $`). Not inside an unfinished escape or a TUI's screen.
  const endsOnNewLine = !info.modes.alternateScreen && !info.pendingEscapeTailAnsi
  return {
    snapshotAnsi: endsOnNewLine ? `${info.snapshotAnsi}\r\n` : info.snapshotAnsi,
    scrollbackAnsi,
    ...(info.oscLinks ? { oscLinks: info.oscLinks } : {}),
    rehydrateSequences: info.rehydrateSequences,
    ...(info.pendingEscapeTailAnsi ? { pendingEscapeTailAnsi: info.pendingEscapeTailAnsi } : {}),
    cwd,
    cols: info.cols,
    rows: info.rows,
    modes: info.modes,
    scrollbackLines: info.scrollbackLines ?? 0,
    ...(info.lastTitle ? { lastTitle: info.lastTitle } : {}),
    ...(info.terminalOwner ? { terminalOwner: info.terminalOwner } : {}),
    checkpointedAt: checkpointedAt.toISOString()
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

import { createHash } from 'node:crypto'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import {
  MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS,
  MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
} from '../../../shared/orcad-migration/orcad-migration-scrollback'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  makeTerminalScrollbackSnapshotRef,
  readTerminalScrollbackStoredBytesSync,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import { compareKeys } from './orcad-source-key-order'

export type ProjectedOrcadMigrationScrollback = {
  session: WorkspaceSessionState
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
  blockedItems: string[]
  leftBehindItems: string[]
}

export function hasDuplicateOrcadMigrationScrollbackDescriptors(
  snapshots: readonly OrcadMigrationTerminalScrollbackSnapshot[]
): boolean {
  const refs = new Set<string>()
  const leaves = new Set<string>()
  for (const snapshot of snapshots) {
    const leaf = `${snapshot.tabId}\0${snapshot.leafId}`
    if (refs.has(snapshot.ref) || leaves.has(leaf)) {
      return true
    }
    refs.add(snapshot.ref)
    leaves.add(leaf)
  }
  return false
}

export function projectOrcadMigrationSessionScrollback(
  session: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage,
  /** "Move anyway" can retain untransferable history while moving its pane. */
  leaveBehind = false
): ProjectedOrcadMigrationScrollback {
  const projected = structuredClone(session)
  const snapshots: OrcadMigrationTerminalScrollbackSnapshot[] = []
  const blockedItems: string[] = []
  const leftBehindItems: string[] = []
  let totalBytes = 0
  for (const [tabId, layout] of Object.entries(projected.terminalLayoutsByTabId ?? {})) {
    const sourceLayout = session.terminalLayoutsByTabId[tabId]
    const localOnly = session.localOnlyScrollbackByTabId?.[tabId]
    const refs: Record<string, string> = {}
    const leafIds = new Set([
      ...Object.keys(sourceLayout.buffersByLeafId ?? {}),
      ...Object.keys(localOnly ?? {}),
      ...Object.keys(sourceLayout.scrollbackRefsByLeafId ?? {})
    ])
    for (const leafId of [...leafIds].sort(compareKeys)) {
      const buffer = inlineLeafBuffer(localOnly, sourceLayout.buffersByLeafId, leafId)
      const sourceRef = sourceLayout.scrollbackRefsByLeafId?.[leafId]
      const ref = buffer ? makeTerminalScrollbackSnapshotRef(tabId, leafId) : sourceRef
      const bytes = buffer
        ? Buffer.from(buffer, 'utf8')
        : sourceRef
          ? readTerminalScrollbackStoredBytesSync(sourceRef, storage)
          : null
      if (
        !ref ||
        !bytes ||
        bytes.length === 0 ||
        bytes.length > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
      ) {
        ;(leaveBehind ? leftBehindItems : blockedItems).push(
          `saved terminal history Orca could not read for tab ${tabId}`
        )
        continue
      }
      if (
        leaveBehind &&
        (snapshots.length + 1 > MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS ||
          totalBytes + bytes.length > MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES)
      ) {
        leftBehindItems.push(`saved terminal history over the move's limit for tab ${tabId}`)
        continue
      }
      totalBytes += bytes.length
      refs[leafId] = ref
      snapshots.push({
        tabId,
        leafId,
        ref,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length
      })
    }
    delete layout.buffersByLeafId
    if (Object.keys(refs).length > 0) {
      layout.scrollbackRefsByLeafId = refs
    } else {
      delete layout.scrollbackRefsByLeafId
    }
  }
  // Route both inline stores through snapshots; a few large panes would overflow the manifest.
  delete projected.localOnlyScrollbackByTabId
  if (
    snapshots.length > MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS ||
    totalBytes > MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
  ) {
    blockedItems.push('more saved terminal history than one move carries: close some terminal tabs')
  }
  snapshots.sort((left, right) =>
    compareKeys(`${left.tabId}\0${left.leafId}`, `${right.tabId}\0${right.leafId}`)
  )
  return { session: projected, snapshots, blockedItems, leftBehindItems }
}

export function readOrcadMigrationSourceScrollbackChunk(args: {
  state: PersistedState
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
  offset: number
  length: number
  storage?: TerminalScrollbackSnapshotStorage
  /** Pending exports can read retained files even after their tabs close. */
  retained?: boolean
}): { bytesBase64: string; totalBytes: number; eof: boolean } {
  const bytes = findSnapshotBytes(args.state, args.descriptor, args.storage, args.retained)
  if (!bytes) {
    throw new Error('orcad_migration_source_snapshot_changed')
  }
  if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > bytes.length) {
    throw new Error('orcad_migration_source_snapshot_offset_invalid')
  }
  const end = Math.min(bytes.length, args.offset + args.length)
  return {
    bytesBase64: bytes.subarray(args.offset, end).toString('base64'),
    totalBytes: bytes.length,
    eof: end === bytes.length
  }
}

export function findSnapshotBytes(
  state: PersistedState,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot,
  storage?: TerminalScrollbackSnapshotStorage,
  retained = false
): Buffer | null {
  for (const session of sessionPartitions(state)) {
    const layout = session.terminalLayoutsByTabId?.[descriptor.tabId]
    if (!layout) {
      continue
    }
    const buffer = inlineLeafBuffer(
      session.localOnlyScrollbackByTabId?.[descriptor.tabId],
      layout.buffersByLeafId,
      descriptor.leafId
    )
    const ref = layout.scrollbackRefsByLeafId?.[descriptor.leafId]
    const bytes = buffer
      ? Buffer.from(buffer, 'utf8')
      : ref === descriptor.ref
        ? readTerminalScrollbackStoredBytesSync(ref, storage)
        : null
    if (matchesOrcadMigrationSnapshotBytes(bytes, descriptor)) {
      return bytes
    }
  }
  const stored = retained ? readTerminalScrollbackStoredBytesSync(descriptor.ref, storage) : null
  return matchesOrcadMigrationSnapshotBytes(stored, descriptor) ? stored : null
}

/** Local-only wins, as in `resolveLeafScrollbackBuffers`: the ordinary park writes it last. */
function inlineLeafBuffer(
  localOnly: Record<string, string> | undefined,
  shared: Record<string, string> | undefined,
  leafId: string
): string | undefined {
  return localOnly?.[leafId] || shared?.[leafId] || undefined
}

export function matchesOrcadMigrationSnapshotBytes(
  bytes: Buffer | null,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot
): bytes is Buffer {
  return (
    bytes !== null &&
    bytes.length === descriptor.byteLength &&
    createHash('sha256').update(bytes).digest('hex') === descriptor.sha256
  )
}

function sessionPartitions(state: PersistedState): WorkspaceSessionState[] {
  return [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})].filter(
    (session): session is WorkspaceSessionState => session !== undefined
  )
}

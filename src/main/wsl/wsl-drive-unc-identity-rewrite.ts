/**
 * The re-key of a UNC Windows-drive project converting to its drive path (D1c): every identity
 * string that names one of its folders through the distro (`\\wsl.localhost\<d>\mnt\c\x`) becomes
 * the same folder's drive path (`C:\x`). Worktree ids, owner keys, PTY session ids and editor file
 * ids are rebuilt by the export's composite rewriters; user text is never touched.
 */
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId, WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import {
  parseEditorFileId,
  WSL_MOVE_FREE_TEXT_KEYS
} from '../persistence/moving-wsl-projects/wsl-move-canonical-form'
import {
  rewriteOrcadMigrationPathValue,
  type OrcadMigrationPathRewriter
} from '../ssh/orcad-migration-path-rewrite'
import { wslUncDrivePathToWindows } from './wsl-drive-unc-project-scope'

export type WslDriveUncRewriteScope = {
  distro: string
  repoIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  /** UNC folders of the converting projects; a bare path is rewritten only at or under one. */
  roots: readonly string[]
}

export type WslDriveUncRewriter = {
  /** A path, file URL, worktree id, owner key, host-qualified key, PTY session id or editor id. */
  identity: (value: string) => string
}

/** Kept as written: the ids a worktree used to have, so stragglers naming them still resolve. */
const VERBATIM_KEYS: ReadonlySet<string> = new Set(['priorWorktreeIds'])

export function createWslDriveUncRewriter(scope: WslDriveUncRewriteScope): WslDriveUncRewriter {
  const fileUrl = new RegExp(
    `^file://(?:wsl\\.localhost|wsl\\$)/${escapeRegExp(scope.distro)}(/mnt/[a-z](?:/[^?#]*)?)([?#].*)?$`,
    'i'
  )
  const comparisonForm = new RegExp(
    `^//wsl/${escapeRegExp(scope.distro.toLowerCase())}/mnt/([a-z])(/[\\s\\S]*)?$`
  )
  const roots = scope.roots.flatMap((root) => {
    const drive = wslUncDrivePathToWindows(root, scope.distro)
    return drive ? [normalizeRuntimePathForComparison(drive)] : []
  })
  const inRoot = (drivePath: string): boolean => {
    const comparable = normalizeRuntimePathForComparison(drivePath)
    return roots.some(
      (root) => comparable === root || comparable.startsWith(root.endsWith('/') ? root : `${root}/`)
    )
  }
  const fileUrlDrivePath = (
    value: string
  ): { drive: string; tail: string; extra: string } | null => {
    const match = fileUrl.exec(value)
    if (!match) {
      return null
    }
    const linux = safeDecode(match[1])
    const drive = linux
      ? wslUncDrivePathToWindows(`//wsl.localhost/${scope.distro}${linux}`, scope.distro)
      : null
    if (!drive) {
      return null
    }
    // `/mnt/c/x` → `C:/x`, keeping the URL's own encoding of the tail.
    const tail = match[1].slice('/mnt/c'.length)
    return { drive, tail, extra: match[2] ?? '' }
  }
  // Any drive path of the distro: an id's owner was checked first.
  const drive: OrcadMigrationPathRewriter = {
    path: (value, form) => {
      if (form === 'relative') {
        return value
      }
      if (form === 'url') {
        const parsed = fileUrlDrivePath(value)
        return parsed
          ? `file:///${parsed.drive.slice(0, 2)}${parsed.tail || '/'}${parsed.extra}`
          : value
      }
      return wslUncDrivePathToWindows(value, scope.distro) ?? value
    }
  }
  const ownerInScope = (owner: string): boolean => {
    const key = parseWorkspaceKey(owner)
    if (key?.type === 'folder') {
      return scope.folderWorkspaceIds.has(key.folderWorkspaceId)
    }
    const id = key?.type === 'worktree' ? key.worktreeId : owner
    return (
      scope.folderWorkspaceIds.has(id) ||
      (id.includes(WORKTREE_ID_SEPARATOR) && scope.repoIds.has(getRepoIdFromWorktreeId(id)))
    )
  }
  const barePath = (value: string): string => {
    const comparison = comparisonForm.exec(value)
    if (comparison) {
      const mapped = `${comparison[1]}:${comparison[2] ?? '/'}`
      return inRoot(mapped) ? mapped : value
    }
    const mapped = wslUncDrivePathToWindows(value, scope.distro)
    return mapped && inRoot(mapped) ? mapped : value
  }
  const identity = (value: string): string => {
    const bar = value.indexOf('|')
    if (bar > 0 && parseExecutionHostId(value.slice(0, bar))) {
      // Another host's copy of a workspace keeps its id there.
      return value.slice(0, bar) === LOCAL_EXECUTION_HOST_ID
        ? `${value.slice(0, bar + 1)}${identity(value.slice(bar + 1))}`
        : value
    }
    const editor = parseEditorFileId(value)
    if (editor) {
      return ownerInScope(editor[0])
        ? rewriteOrcadMigrationPathValue(value, 'editor-file-id', drive)
        : value
    }
    const session = value.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
    if (session > 0) {
      return ownerInScope(value.slice(0, session))
        ? rewriteOrcadMigrationPathValue(value, 'pty-session-id', drive)
        : value
    }
    if (parseWorkspaceKey(value) || value.includes(WORKTREE_ID_SEPARATOR)) {
      return ownerInScope(value) ? rewriteOrcadMigrationPathValue(value, 'owner-key', drive) : value
    }
    if (/^file:/i.test(value)) {
      const parsed = fileUrlDrivePath(value)
      return parsed && inRoot(parsed.drive) ? drive.path(value, 'url') : value
    }
    return barePath(value)
  }
  return { identity }
}

/**
 * `value` with every identity string and record key passed through `rewriter`, skipping user text
 * and the verbatim keys; unchanged subtrees keep their reference. Throws when two keys of one
 * record would become the same key.
 */
export function rewriteWslDriveUncValue<T>(value: T, rewriter: WslDriveUncRewriter): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rewriteNode maps strings to strings and rebuilds arrays and records in place, so the shape of T is kept.
  return rewriteNode(value, rewriter.identity, false) as T
}

function rewriteNode(value: unknown, map: (value: string) => string, skip: boolean): unknown {
  if (skip) {
    return value
  }
  if (typeof value === 'string') {
    return map(value)
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const mapped = rewriteNode(item, map, false)
      changed ||= mapped !== item
      return mapped
    })
    return changed ? next : value
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  let changed = false
  const entries: [string, unknown][] = []
  const seen = new Set<string>()
  for (const [key, child] of Object.entries(value)) {
    const verbatim = WSL_MOVE_FREE_TEXT_KEYS.has(key) || VERBATIM_KEYS.has(key)
    const nextKey = map(key)
    const nextChild = rewriteNode(child, map, verbatim)
    if (seen.has(nextKey)) {
      throw new Error('wsl_drive_unc_key_collision')
    }
    seen.add(nextKey)
    changed ||= nextKey !== key || nextChild !== child
    entries.push([nextKey, nextChild])
  }
  return changed ? Object.fromEntries(entries) : value
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

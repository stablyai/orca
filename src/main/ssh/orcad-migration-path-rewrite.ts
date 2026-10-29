/** Rewrite differing source/destination paths, such as WSL via \wsl.localhost; SSH identity rewriting must preserve payload bytes. */
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import { isRecord } from '../../shared/orcad-migration/orcad-migration-manifest-fields'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { rewriteWorktreeIdPath } from '../../shared/worktree/id'
import {
  ORCAD_MIGRATION_PATH_FIELDS,
  type OrcadMigrationPathFieldKind,
  type OrcadMigrationPathForm
} from './orcad-migration-path-fields'

export type OrcadMigrationPathRewriter = {
  /** Must return anything it does not recognise as a source path unchanged. */
  path: (value: string, form: OrcadMigrationPathForm) => string
}

export const IDENTITY_ORCAD_MIGRATION_PATH_REWRITER: OrcadMigrationPathRewriter = {
  path: (value) => value
}

/** A rewritten copy; the input is never mutated. Throws when two keys of a record would merge. */
export function rewriteOrcadMigrationPayloadPaths(
  payload: OrcadMigrationCatalogPayload,
  rewriter: OrcadMigrationPathRewriter
): OrcadMigrationCatalogPayload {
  const copy = structuredClone(payload)
  // Stage/commit checks repeat identity exports; skip traversal when every path stays unchanged.
  if (rewriter === IDENTITY_ORCAD_MIGRATION_PATH_REWRITER) {
    return copy
  }
  for (const field of ORCAD_MIGRATION_PATH_FIELDS) {
    const map = (value: string): string => rewriteValue(value, field.kind, rewriter)
    visit(copy, parseFieldLocation(field.at), map)
  }
  return copy
}

type Step =
  | { type: 'prop'; name: string }
  | { type: 'items' }
  | { type: 'values' }
  | { type: 'keys' }

export function parseFieldLocation(at: string): Step[] {
  const steps: Step[] = []
  for (const token of at.match(/[^.[\]{}]+|\[\]|\{\}|\{key\}/g) ?? []) {
    steps.push(
      token === '[]'
        ? { type: 'items' }
        : token === '{}'
          ? { type: 'values' }
          : token === '{key}'
            ? { type: 'keys' }
            : { type: 'prop', name: token }
    )
  }
  return steps
}

function visit(node: unknown, steps: Step[], map: (value: string) => string): unknown {
  const [step, ...rest] = steps
  if (!step) {
    return typeof node === 'string' ? map(node) : node
  }
  if (step.type === 'items') {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        node[index] = visit(item, rest, map)
      })
    }
    return node
  }
  if (!isRecord(node)) {
    return node
  }
  if (step.type === 'prop') {
    if (Object.hasOwn(node, step.name)) {
      node[step.name] = visit(node[step.name], rest, map)
    }
    return node
  }
  if (step.type === 'values') {
    for (const key of Object.keys(node)) {
      node[key] = visit(node[key], rest, map)
    }
    return node
  }
  renameKeys(node, map)
  return node
}

function renameKeys(node: Record<string, unknown>, map: (value: string) => string): void {
  const keys = Object.keys(node)
  const entries = keys.map((key) => [map(key), node[key]] as const)
  if (entries.every(([key], index) => key === keys[index])) {
    return
  }
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error('orcad_migration_path_rewrite_key_collision')
  }
  for (const key of Object.keys(node)) {
    delete node[key]
  }
  for (const [key, value] of entries) {
    node[key] = value
  }
}

function rewriteValue(
  value: string,
  kind: OrcadMigrationPathFieldKind,
  rewriter: OrcadMigrationPathRewriter
): string {
  switch (kind) {
    case 'worktree-id':
      return rewriteOrcadMigrationWorktreeId(value, rewriter)
    case 'owner-key':
      return rewriteOwnerKey(value, rewriter)
    case 'pty-session-id':
      return rewritePtySessionId(value, rewriter)
    case 'editor-file-id':
      return rewriteEditorFileId(value, rewriter)
    case 'absolute':
    case 'maybe-absolute':
    case 'relative':
    case 'url':
      return rewriter.path(value, kind)
  }
}

export function rewriteOrcadMigrationWorktreeId(
  value: string,
  rewriter: OrcadMigrationPathRewriter
): string {
  return rewriteWorktreeIdPath(value, (path) => rewriter.path(path, 'absolute'))
}

function rewriteOwnerKey(value: string, rewriter: OrcadMigrationPathRewriter): string {
  const scope = parseWorkspaceKey(value)
  if (scope?.type === 'folder') {
    return value
  }
  if (scope?.type === 'worktree') {
    const mapped = rewriteOrcadMigrationWorktreeId(scope.worktreeId, rewriter)
    return mapped === scope.worktreeId ? value : `worktree:${mapped}`
  }
  return rewriteOrcadMigrationWorktreeId(value, rewriter)
}

function rewritePtySessionId(value: string, rewriter: OrcadMigrationPathRewriter): string {
  const at = value.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  if (at <= 0) {
    return value
  }
  const owner = value.slice(0, at)
  const mapped = rewriteOwnerKey(owner, rewriter)
  return mapped === owner ? value : `${mapped}${value.slice(at)}`
}

function rewriteEditorFileId(value: string, rewriter: OrcadMigrationPathRewriter): string {
  const parts = value.split(':')
  if (parts[0] !== 'editor' || parts.length !== 4) {
    return rewriter.path(value, 'maybe-absolute')
  }
  let decoded: string[]
  try {
    decoded = parts.slice(1).map((part) => decodeURIComponent(part))
  } catch {
    return value
  }
  const [worktreeId, runtime, filePath] = decoded
  const mappedWorktreeId = rewriteOrcadMigrationWorktreeId(worktreeId, rewriter)
  const mappedFilePath = rewriter.path(filePath, 'absolute')
  if (mappedWorktreeId === worktreeId && mappedFilePath === filePath) {
    return value
  }
  return ['editor', mappedWorktreeId, runtime, mappedFilePath]
    .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
    .join(':')
}

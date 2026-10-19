/**
 * The string and key normalization behind the WSL move projection: a UNC path of the moved distro
 * and its Linux path, or any alias of the owning host, compare equal. Only identity-shaped strings
 * are normalized, and never user text, so a move that rewrites a draft or a comment still shows.
 */
import type { WslMoveProjectionScope } from './wsl-move-state-projection'

/** Subtrees of user-authored text and terminal output, compared byte for byte. */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'dirtyDraftContent',
  'comment',
  'prompt',
  'lastAssistantMessage',
  'buffersByLeafId',
  'localOnlyScrollbackByTabId',
  'hookSettings',
  'outputSnapshot',
  'body',
  'text',
  'title',
  'customTitle',
  'generatedTitle',
  'label',
  'customLabel',
  'displayName',
  'name',
  'titlesByLeafId',
  'selectedText'
])

/** `editor:<enc worktreeId>:<enc runtime>:<enc filePath>` → its three decoded parts. */
export function parseEditorFileId(value: string): [string, string, string] | null {
  if (!value.startsWith('editor:')) {
    return null
  }
  const parts = value.slice('editor:'.length).split(':')
  if (parts.length !== 3) {
    return null
  }
  try {
    const [worktreeId, runtime, filePath] = parts.map(decodeURIComponent)
    return [worktreeId, runtime, filePath]
  } catch {
    return null
  }
}

export function createWslMoveStringNormalizer(
  scope: Pick<WslMoveProjectionScope, 'distro' | 'hostAliases'>
): (value: string) => string {
  const distro = escapeRegExp(scope.distro)
  // A path, a worktree id (`<repo>::<path>[::workspace:<id>]`) or an owner key whose path is a UNC
  // path of the distro. Path segments stop at `:`, which only the id suffix uses.
  const uncIdentity = new RegExp(
    `^((?:worktree:)?(?:[^\\s\\\\/]*::)?)(?:\\\\\\\\|//)(?:wsl\\.localhost|wsl\\$)[\\\\/]${distro}((?:[\\\\/][^\\\\/:]*)*)(::.*)?$`,
    'i'
  )
  const fileUrl = new RegExp(`^file://(?:wsl\\.localhost|wsl\\$)/${distro}(?:/|$)`, 'i')
  const aliases = new Set(scope.hostAliases)
  const normalize = (value: string): string => {
    if (aliases.has(value)) {
      return '<H>'
    }
    const separator = value.indexOf('|')
    // A key qualified by the owning host names the same row as the bare key the import writes.
    if (separator > 0 && aliases.has(value.slice(0, separator))) {
      return normalize(value.slice(separator + 1))
    }
    const editor = parseEditorFileId(value)
    if (editor) {
      return `editor:${editor.map((part) => encodeURIComponent(normalize(part))).join(':')}`
    }
    if (fileUrl.test(value)) {
      return value.replace(fileUrl, 'file:///')
    }
    const unc = uncIdentity.exec(value)
    if (!unc) {
      return value
    }
    const [, prefix, rest, suffix = ''] = unc
    return `${prefix}${rest.replace(/\\/g, '/') || '/'}${suffix}`
  }
  return normalize
}

/**
 * Normalizes identity strings and every key, drops `droppedKeys`, and sorts keys. Throws when two
 * keys of one record become the same key, i.e. two spellings of one thing.
 */
export function canonicalizeWslMoveValue(
  value: unknown,
  normalize: (value: string) => string,
  droppedKeys: ReadonlySet<string>,
  freeText = false
): unknown {
  if (typeof value === 'string') {
    return freeText ? value : normalize(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeWslMoveValue(item, normalize, droppedKeys, freeText))
  }
  if (!isRecord(value)) {
    return value
  }
  const entries: [string, unknown][] = []
  const originalByKey = new Map<string, string>()
  for (const [key, child] of Object.entries(value)) {
    if (droppedKeys.has(key) || child === undefined) {
      continue
    }
    const normalizedKey = freeText ? key : normalize(key)
    const canonical = canonicalizeWslMoveValue(
      child,
      normalize,
      droppedKeys,
      freeText || FREE_TEXT_KEYS.has(key)
    )
    const earlier = originalByKey.get(normalizedKey)
    if (earlier !== undefined) {
      // The same row under a qualified and a bare key is one row; two different rows are a refusal.
      const kept = entries.find(([existing]) => existing === normalizedKey)?.[1]
      if (JSON.stringify(kept) !== JSON.stringify(canonical)) {
        throw new Error(`Two keys name the same thing after the move: ${earlier} and ${key}`)
      }
      continue
    }
    originalByKey.set(normalizedKey, key)
    entries.push([normalizedKey, canonical])
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return Object.fromEntries(entries)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

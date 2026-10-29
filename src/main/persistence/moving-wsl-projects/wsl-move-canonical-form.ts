// Normalize host/path identities for comparison; preserve user text and terminal output byte for byte.
import type { WslMoveProjectionScope } from './wsl-move-state-projection'

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

/** Decode editor:<worktreeId>:<runtime>:<filePath>. */
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
  // Match distro UNC identities; colons delimit worktree suffixes rather than path segments.
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
    // Qualified and bare keys identify the same moved row.
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

/** Normalize identities and sorted keys; refuse collisions unless their values match. */
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
      // Equal aliases can collapse; conflicting rows must refuse.
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

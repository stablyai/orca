import { boundInlineText } from '../agent-session-journal/item-lifecycle/journal-payload-bounds'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function readString(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === 'string' && source[key].length > 0 ? source[key] : null
}

export function providerFileChangeApprovalDetail(
  changes: unknown,
  maxBytes = 64 * 1024
): string | null {
  if (!Array.isArray(changes)) {
    return null
  }
  const files = changes.flatMap((value) => {
    const change = readRecord(value)
    const path = readString(change, 'path')
    if (!path) {
      return []
    }
    const kind = readRecord(change.kind)
    const type = readString(kind, 'type')
    const movePath = readString(kind, 'move_path')
    const label = `${type ? `${type} ` : ''}${path}${movePath ? ` -> ${movePath}` : ''}`
    const diff = typeof change.diff === 'string' ? change.diff : ''
    const moveNote = movePath ? `\n\nMoved to: ${movePath}` : null
    return [
      {
        path,
        label,
        diff: moveNote && diff.endsWith(moveNote) ? diff.slice(0, -moveNote.length) : diff
      }
    ]
  })
  if (files.length === 0) {
    return null
  }
  // List every file before diff content so a large first diff cannot hide later paths.
  const summary = files.map((file) => file.label).join('\n')
  const patches = files
    .filter((file) => file.diff.length > 0)
    .map((file) => (files.length === 1 ? file.diff : `${file.path}\n${file.diff}`))
  return boundInlineText([summary, ...patches].join('\n\n'), {
    inlineHeadBytes: maxBytes
  }).text
}

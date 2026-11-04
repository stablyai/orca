import { boundInlineText } from '../../../native-chat/agent-session-journal/journal-payload-bounds'
import { MAX_CODEX_DETAIL_BYTES } from '../journal/codex-structured-journal-limits'
import {
  readCodexItemStreamRecord,
  readCodexItemStreamString
} from '../items/codex-structured-item-stream-events'

export function codexFileChangeApprovalDetail(changes: unknown): string | null {
  if (!Array.isArray(changes)) {
    return null
  }
  const files = changes.flatMap((value) => {
    const change = readCodexItemStreamRecord(value)
    const path = readCodexItemStreamString(change, 'path')
    if (!path) {
      return []
    }
    const kind = readCodexItemStreamRecord(change.kind)
    const type = readCodexItemStreamString(kind, 'type')
    const movePath = readCodexItemStreamString(kind, 'move_path')
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
    inlineHeadBytes: MAX_CODEX_DETAIL_BYTES
  }).text
}

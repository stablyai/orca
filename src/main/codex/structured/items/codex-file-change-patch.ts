import { splitMoveMarker } from '../../../../shared/native-chat/tools/native-chat-edit-patch-files'
import { AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES } from '../../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import { readRecord, readString } from '../../app-server/codex-item-field-readers'
import { replacementHunk } from '../../../native-chat/agent-session-timeline/provider-timeline-replacement-patch'

type CodexFileChange = { path: string; diff: string; kind: unknown }

/** Header parsing cuts names at a tab and trims them, so such a name would be shown wrong. */
const UNSAFE_HEADER_PATH = /[\t\r\n]|^\s|\s$/

/** Git headers bound each file; Codex's own diffs carry none, so joined files would be unattributable. */
function fileChangeSection(change: CodexFileChange): string | null {
  const kind = readRecord(change.kind)
  const type = readString(kind, 'type')
  const whole = type === 'add' || type === 'delete'
  // Only an update carries the Moved to marker; raw add/delete content may end in that text.
  const update = whole ? null : splitMoveMarker(change.diff)
  const oldPath = type === 'add' ? null : change.path
  // Rollout history spells the move `movePath`, but both sources append the marker.
  const newPath =
    type === 'delete' ? null : (readString(kind, 'move_path') ?? update?.movedTo ?? change.path)
  if (
    UNSAFE_HEADER_PATH.test(change.path) ||
    (newPath !== null && UNSAFE_HEADER_PATH.test(newPath))
  ) {
    return null
  }
  // Add and delete arrive as raw file content, so they become one whole-file hunk.
  const body = update
    ? update.body.replace(/\n+$/, '')
    : (type === 'add'
        ? replacementHunk('', change.diff)
        : replacementHunk(change.diff, '')
      ).replace(/\r?\n$/, '')
  return [
    `diff --git a/${oldPath ?? change.path} b/${newPath ?? change.path}`,
    `--- ${oldPath === null ? '/dev/null' : `a/${oldPath}`}`,
    `+++ ${newPath === null ? '/dev/null' : `b/${newPath}`}`,
    ...(body === '' ? [] : [body])
  ].join('\n')
}

/** Single files and patches past the wire head or with header-unsafe names keep the plain join. */
export function codexFileChangePatch(changes: readonly CodexFileChange[]): string {
  const plain = (): string => changes.map((change) => change.diff).join('\n')
  const rawLength = changes.reduce((total, change) => total + change.diff.length, 0)
  if (changes.length === 1 || rawLength > AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES) {
    return plain()
  }
  const sections: string[] = []
  for (const change of changes) {
    const section = fileChangeSection(change)
    if (section === null) {
      return plain()
    }
    sections.push(section)
  }
  return sections.join('\n')
}

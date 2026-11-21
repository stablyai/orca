import type { DiffComment } from '../../shared/diff-comment-types'

function noteLocation(note: DiffComment): string {
  const lines =
    note.startLine !== undefined && note.startLine < note.lineNumber
      ? `${note.startLine}-${note.lineNumber}`
      : `${note.lineNumber}`
  return `${note.filePath}:${lines}`
}

function byLocation(a: DiffComment, b: DiffComment): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    (a.startLine ?? a.lineNumber) - (b.startLine ?? b.lineNumber) ||
    a.createdAt - b.createdAt
  )
}

export function formatNoteList({ notes }: { notes: DiffComment[] }): string {
  if (notes.length === 0) {
    return 'No review notes.'
  }
  return [...notes]
    .sort(byLocation)
    .map((note) => {
      const body = note.body
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
      return `${noteLocation(note)}  ${note.id}${note.sentAt ? '  (sent)' : ''}\n${body}`
    })
    .join('\n\n')
}

export function formatAddedNote({ note }: { note: DiffComment }): string {
  return `Added note ${note.id} on ${noteLocation(note)}`
}

export function formatClearedNotes({ removed }: { removed: DiffComment[] }): string {
  if (removed.length === 0) {
    return 'No matching review notes.'
  }
  return `Deleted ${removed.length} review ${removed.length === 1 ? 'note' : 'notes'}.`
}

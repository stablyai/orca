// How `orca drive|docs|sheets` print their answers: Orca's own lines plain, every file name and
// every text someone else wrote fenced as content, and the whole answer capped.
import type {
  DocsComment,
  DocsReadView,
  DocsWriteView,
  DriveFileSummary,
  DriveListView,
  DriveReadView,
  DriveWriteView,
  SheetsReadView,
  SheetsWriteView
} from '../../shared/google/google-files-types'
import { sheetTable, splitA1 } from '../../shared/google/sheets-a1'
import { inlineUntrusted, untrustedContent } from '../../shared/quoted-text-fence'
import { capToolOutput } from '../../shared/tool-output-limits'
import { formatWhen } from './google-read-format'

const KINDS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
  'application/vnd.google-apps.folder': 'folder',
  'application/pdf': 'PDF'
}

const kind = (mimeType: string) => KINDS[mimeType] ?? mimeType.replace(/^application\/(vnd\.)?/, '')

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`

function fileLine(file: DriveFileSummary): string {
  return [
    file.id,
    inlineUntrusted(file.name, 120),
    kind(file.mimeType),
    ...(file.modifiedAt !== undefined ? [`modified ${formatWhen(file.modifiedAt)}`] : []),
    ...(file.size !== undefined ? [size(file.size)] : []),
    ...(file.owner ? [`owner ${inlineUntrusted(file.owner, 120)}`] : [])
  ].join(' · ')
}

/** Orca's line for a file: only what Orca made (its id, kind, link), never its name. */
const orcaFileLine = (file: DriveFileSummary) =>
  [file.id, kind(file.mimeType), ...(file.link ? [file.link] : [])].join(' · ')

/** Names as Google has them, fenced: a file name or title is anyone's text. */
const names = (lines: string[]) => untrustedContent('names as Google has them', lines.join('\n'))

export function formatDriveList(view: DriveListView, more: string): string {
  if (view.files.length === 0) {
    return `No files${view.folder ? ` in folder ${view.folder.id}` : ''} for ${view.account}.`
  }
  return [
    capToolOutput(
      [
        `${view.files.length} file${view.files.length === 1 ? '' : 's'}${view.folder ? ` in folder ${view.folder.id}` : ''} for ${view.account}; \`orca drive read <id>\` opens one.`,
        untrustedContent('files as Drive lists them', view.files.map(fileLine).join('\n'))
      ].join('\n'),
      'Pass --limit for fewer.'
    ),
    ...(view.nextPageToken ? [`Next page: ${more} --page ${view.nextPageToken}`] : [])
  ].join('\n')
}

const partLine = (part: { from: number; to: number; of: number } | undefined) =>
  part ? [`[Orca: characters ${part.from}–${part.to} of ${part.of}]`] : []

export function formatDriveRead(view: DriveReadView): string {
  const about = [
    `Name: ${view.file.name}`,
    ...(view.file.owner ? [`Owner: ${view.file.owner}`] : []),
    ...(view.file.modifiedAt !== undefined ? [`Modified: ${formatWhen(view.file.modifiedAt)}`] : [])
  ]
  return [
    capToolOutput(
      [
        `${orcaFileLine(view.file)} (${view.source})`,
        untrustedContent('the file', [...about, '', view.text || '(no text)'].join('\n'))
      ].join('\n'),
      'Read on with --offset.'
    ),
    ...partLine(view.part),
    ...(view.nextOffset !== undefined
      ? [`More: orca drive read ${view.file.id} --offset ${view.nextOffset}`]
      : [])
  ].join('\n')
}

export function formatDriveWrite(view: DriveWriteView): string {
  return [
    `${view.done}${view.folder ? ` into folder ${view.folder.id}` : ''}: ${orcaFileLine(view.file)}`,
    names([`Name: ${view.file.name}`, ...(view.folder ? [`Folder: ${view.folder.name}`] : [])])
  ].join('\n')
}

function commentBlock(comment: DocsComment, index: number): string {
  return untrustedContent(
    `comment ${index + 1}`,
    [
      `By: ${comment.author}`,
      ...(comment.quote ? [`On: "${comment.quote}"`] : []),
      '',
      comment.text,
      ...comment.replies.map((reply) => `\nReply by ${reply.author}:\n${reply.text}`)
    ].join('\n')
  )
}

export function formatDocsRead(view: DocsReadView): string {
  const hidden = view.part && view.part.from > 0 ? 0 : view.openComments - view.comments.length
  const atLeast = view.moreComments ? '+' : ''
  const commentLines =
    view.part && view.part.from > 0
      ? []
      : view.openComments === 0 && !view.moreComments
        ? ['[Orca: no open comments]']
        : [
            `[Orca: ${view.openComments}${atLeast} open comment${view.openComments === 1 && !atLeast ? '' : 's'}]`,
            ...view.comments.map(commentBlock),
            ...(hidden > 0
              ? [`[Orca: ${hidden}${atLeast} more not shown; they are in the doc]`]
              : [])
          ]
  return [
    capToolOutput(
      [
        `${view.id} · ${view.link}`,
        untrustedContent(
          'the doc',
          [`Title: ${view.title}`, '', view.text || '(empty)'].join('\n')
        ),
        view.suggestions
          ? `[Orca: ${view.suggestions} pending suggestion${view.suggestions === 1 ? '' : 's'}, shown as [+added+] and [-removed-]]`
          : '[Orca: no pending suggestions]',
        ...commentLines
      ].join('\n'),
      'Read on with --offset.'
    ),
    ...partLine(view.part),
    ...(view.nextOffset !== undefined
      ? [`More: orca docs read ${view.id} --offset ${view.nextOffset}`]
      : [])
  ].join('\n')
}

export function formatDocsWrite(view: DocsWriteView): string {
  return [
    `${view.done}${view.folder ? ` in folder ${view.folder.id}` : ''}: ${view.id} · ${view.link}`,
    names([`Title: ${view.title}`, ...(view.folder ? [`Folder: ${view.folder.name}`] : [])])
  ].join('\n')
}

export function formatSheetsRead(view: SheetsReadView): string {
  const tab = splitA1(view.range).tab
  const about = [
    `Title: ${view.title}`,
    `Tabs: ${view.tabs.map((entry) => `${entry.title} (${entry.rows}×${entry.columns})`).join(', ')}`,
    `Cells: ${view.range}`,
    ''
  ]
  return [
    capToolOutput(
      [
        `${view.id} · ${view.link}`,
        untrustedContent(
          'the spreadsheet',
          [
            ...about,
            view.values.length ? sheetTable(view.values, view.origin) : '(no values)'
          ].join('\n')
        )
      ].join('\n'),
      'Read a smaller --range.'
    ),
    ...(view.nextRange
      ? [
          `More rows: orca sheets read ${view.id}${tab ? ` --tab ${JSON.stringify(inlineUntrusted(tab, 100))}` : ''} --range ${view.nextRange}`
        ]
      : [])
  ].join('\n')
}

export function formatSheetsWrite(view: SheetsWriteView): string {
  return [
    `${view.done}: ${view.id} · ${view.link}`,
    names([
      `Title: ${view.title}`,
      ...(view.ranges.length ? [`Cells: ${view.ranges.join(', ')}`] : [])
    ])
  ].join('\n')
}

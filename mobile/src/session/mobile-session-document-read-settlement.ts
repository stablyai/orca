import type { MobileFileMedia } from '../files/mobile-file-media'
import type { MobileDiffLine } from './mobile-diff-lines'
import type {
  FileDocState,
  MarkdownDocState,
  ReadyFileDocState
} from './mobile-session-route-types'

export function claimDocumentRead(sequences: Map<string, number>, tabId: string): number {
  const seq = (sequences.get(tabId) ?? 0) + 1
  sequences.set(tabId, seq)
  return seq
}

export function documentReadIsCurrent(
  sequences: Map<string, number>,
  tabId: string,
  seq: number
): boolean {
  return sequences.get(tabId) === seq
}

/** A dirty ready doc is a discard and must reload. A clean one stays up and refreshes behind it. */
export function keepMarkdownVisibleDuringRead(current: MarkdownDocState | undefined): boolean {
  return current?.status === 'ready' && !current.isDirty
}

export function keepFileVisibleDuringRead(current: FileDocState | undefined): boolean {
  return current?.status === 'ready'
}

export function installDocumentReadPlaceholder<Doc extends { status: string }>(
  prev: Map<string, Doc>,
  tabId: string,
  loading: Doc,
  keepVisible: (current: Doc | undefined) => boolean
): Map<string, Doc> {
  if (keepVisible(prev.get(tabId))) {
    return prev
  }
  const next = new Map(prev)
  next.set(tabId, loading)
  return next
}

export function commitDocumentRead<Doc extends { status: string }>(
  prev: Map<string, Doc>,
  tabId: string,
  loading: Doc,
  nextDoc: Doc,
  settle: (current: Doc, loading: Doc, nextDoc: Doc) => Doc | undefined
): Map<string, Doc> {
  const current = prev.get(tabId)
  if (!current) {
    return prev
  }
  const settled = settle(current, loading, nextDoc)
  if (!settled || settled === current) {
    return prev
  }
  const next = new Map(prev)
  next.set(tabId, settled)
  return next
}

/** Edits and saves made during a reread win; unchanged content and metadata keep the view. */
export function settleMarkdownRead(
  current: MarkdownDocState,
  loading: MarkdownDocState,
  nextDoc: MarkdownDocState,
  visibleAtStart: MarkdownDocState | undefined
): MarkdownDocState | undefined {
  if (current.status === 'ready') {
    if (
      visibleAtStart?.status !== 'ready' ||
      current.localRevision !== visibleAtStart.localRevision ||
      current.content !== visibleAtStart.content ||
      current.localContent !== visibleAtStart.localContent ||
      current.baseVersion !== visibleAtStart.baseVersion ||
      current.isDirty ||
      current.saving ||
      nextDoc.status !== 'ready'
    ) {
      return undefined
    }
    // A snapshot received during the read may describe a newer desktop edit than its reply.
    const refreshed =
      current !== visibleAtStart && current.stale && !nextDoc.stale
        ? { ...nextDoc, stale: true }
        : nextDoc
    if (
      (
        [
          'content',
          'localContent',
          'baseVersion',
          'isDirty',
          'editable',
          'stale',
          'readOnlyReason',
          'truncated',
          'byteLength',
          'saving',
          'saveError'
        ] as const
      ).every((field) => current[field] === refreshed[field])
    ) {
      return undefined
    }
    return current.localRevision === undefined
      ? refreshed
      : { ...refreshed, localRevision: current.localRevision }
  }
  if (current !== loading) {
    return undefined
  }
  return nextDoc
}

export function settleFileRead(
  current: FileDocState,
  loading: FileDocState,
  nextDoc: FileDocState
): FileDocState | undefined {
  if (current.status === 'ready') {
    if (nextDoc.status !== 'ready' || readyFileDocsMatch(current, nextDoc)) {
      return undefined
    }
    return nextDoc
  }
  if (current !== loading) {
    return undefined
  }
  return nextDoc
}

function readyFileDocsMatch(current: ReadyFileDocState, next: FileDocState): boolean {
  if (next.status !== 'ready' || current.kind !== next.kind) {
    return false
  }
  switch (current.kind) {
    case 'file':
      return (
        next.kind === 'file' &&
        current.content === next.content &&
        current.truncated === next.truncated &&
        current.byteLength === next.byteLength
      )
    case 'html':
      return next.kind === 'html' && current.content === next.content
    case 'image':
      return next.kind === 'image' && current.dataUri === next.dataUri
    case 'media':
      return next.kind === 'media' && sameMedia(current.media, next.media)
    case 'diff':
      return (
        next.kind === 'diff' &&
        current.truncated === next.truncated &&
        sameDiffLines(current.lines, next.lines)
      )
  }
}

function sameMedia(current: MobileFileMedia, next: MobileFileMedia): boolean {
  return (
    current.worktreeId === next.worktreeId &&
    current.relativePath === next.relativePath &&
    current.mimeType === next.mimeType
  )
}

function sameDiffLines(
  current: readonly MobileDiffLine[],
  next: readonly MobileDiffLine[]
): boolean {
  if (current.length !== next.length) {
    return false
  }
  return current.every((line, index) => {
    const other = next[index]
    return (
      line.kind === other?.kind &&
      line.text === other?.text &&
      line.oldLineNumber === other?.oldLineNumber &&
      line.newLineNumber === other?.newLineNumber
    )
  })
}

import type { DiffComment } from '../../../../src/shared/diff-comment-types'
import type { MobileDiffLine } from './mobile-diff-lines'
import type { MobileHighlightedDiffLine } from '../../files/session-documents/mobile-file-syntax'
import type { ReadyFileDocState } from '../../files/session-documents/session-document-state'

export type RenderableDiffLine = MobileHighlightedDiffLine<MobileDiffLine>

export type DiffCommentActions = {
  comments: DiffComment[]
  sendingCommentIds: ReadonlySet<string>
  busy: boolean
  onAdd: (filePath: string, lineNumber: number, body: string) => Promise<boolean>
  onDelete: (commentId: string) => Promise<void>
  onCopyAll: () => Promise<void>
  onSendAll: () => void
}

export type DiffNotesDelivery = {
  prompt: string
  comments: DiffComment[]
}

export type DiffSyntaxState = {
  doc: ReadyFileDocState
  language: string
  lines: RenderableDiffLine[]
}

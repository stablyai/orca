import type { MobileFileMedia } from '../media/mobile-file-media'
import type { MobileDiffLine } from '../../source-control/review/diff-state/mobile-diff-lines'
import type { MobileSyntaxSegment } from './mobile-file-syntax'

export type MarkdownDocState =
  | { status: 'loading' }
  | {
      status: 'ready'
      content: string
      localContent: string
      baseVersion: string
      isDirty: boolean
      editable: boolean
      stale?: boolean
      saving?: boolean
      saveError?: string
      /** Changes only on phone edits and saves, not host metadata updates. */
      localRevision?: number
      readOnlyReason?: string
      truncated?: true
      byteLength?: number
    }
  | { status: 'error'; message: string }

export type FileDocState =
  | { status: 'ready'; kind: 'media'; media: MobileFileMedia }
  | { status: 'loading' }
  | { status: 'ready'; kind: 'file'; content: string; truncated: boolean; byteLength: number }
  | { status: 'ready'; kind: 'diff'; lines: MobileDiffLine[]; truncated: boolean }
  | { status: 'ready'; kind: 'image'; dataUri: string }
  | { status: 'ready'; kind: 'html'; content: string }
  | { status: 'ready'; kind: 'svg'; content: string; truncated: boolean; byteLength: number }
  | { status: 'error'; message: string }

export type ReadyFileDocState = Extract<FileDocState, { status: 'ready' }>

export type FileSyntaxState = {
  doc: ReadyFileDocState
  language: string
  segments: MobileSyntaxSegment[]
}

export type DirtyMarkdownDraft = {
  tabId: string
  title: string
  content: string
}

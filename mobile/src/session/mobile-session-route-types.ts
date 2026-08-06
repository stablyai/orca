import type { DiffComment, TuiAgent } from '../../../src/shared/types'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileBrowserTab } from '../browser/MobileBrowserPane'
import type { MobileTerminalTheme } from '../terminal/terminal-webview-contract'
import type { MobileDiffLine } from './mobile-diff-lines'
import type { MobileHighlightedDiffLine, MobileSyntaxSegment } from './mobile-file-syntax'
import type { TerminalRecord } from './mobile-terminal-records'

export type Terminal = TerminalRecord

export type MobileSessionTabType = 'terminal' | 'markdown' | 'file' | 'browser'

export type MobileSessionTab =
  | {
      type: 'terminal'
      id: string
      title: string
      parentTabId?: string
      leafId?: string
      status?: 'pending-handle' | 'ready'
      terminal: string | null
      agentStatus?: AgentStatusEntry | null
      /** Agent Orca launched in this terminal, if any. This makes chat eligible
       *  before the first live agent-status update reaches the mobile client. */
      launchAgent?: TuiAgent
      /** Host-provided launch context still parked as an unsent TUI-input draft. */
      launchDraft?: string
      launchDraftCreatedAt?: number
      terminalTheme?: MobileTerminalTheme
      isActive: boolean
    }
  | {
      type: 'markdown'
      id: string
      title: string
      filePath: string
      relativePath: string
      isDirty: boolean
      isActive: boolean
      documentVersion: string
    }
  | {
      type: 'file'
      id: string
      title: string
      filePath: string
      relativePath: string
      language?: string
      mode?: 'edit' | 'diff'
      diffSource?: 'staged' | 'unstaged' | 'branch' | 'commit'
      isDirty: boolean
      isActive: boolean
    }
  | MobileBrowserTab

export type SessionTabsResult = {
  worktree: string
  publicationEpoch?: string
  snapshotVersion: number
  tabs: MobileSessionTab[]
  activeTabId: string | null
  activeTabType: MobileSessionTabType | null
}

export type RuntimeStatusResult = {
  capabilities?: string[]
}

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
      readOnlyReason?: string
    }
  | { status: 'error'; message: string }

export type FileDocState =
  | { status: 'loading' }
  | { status: 'ready'; kind: 'file'; content: string; truncated: boolean; byteLength: number }
  | { status: 'ready'; kind: 'diff'; lines: MobileDiffLine[]; truncated: boolean }
  | { status: 'ready'; kind: 'image'; dataUri: string }
  | { status: 'ready'; kind: 'html'; content: string }
  | { status: 'error'; message: string }

export type RenderableDiffLine = MobileHighlightedDiffLine<MobileDiffLine>

export type DiffCommentActions = {
  comments: DiffComment[]
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

export type ReadyFileDocState = Extract<FileDocState, { status: 'ready' }>

export type FileSyntaxState = {
  doc: ReadyFileDocState
  language: string
  segments: MobileSyntaxSegment[]
}

export type DiffSyntaxState = {
  doc: ReadyFileDocState
  language: string
  lines: RenderableDiffLine[]
}

export type DirtyMarkdownDraft = {
  tabId: string
  title: string
  content: string
}

export type TerminalCreateResult = {
  tab: Extract<MobileSessionTab, { type: 'terminal' }>
}

export type MobileNewTabAgentLoadState = 'idle' | 'loading' | 'loaded' | 'error'

export type RuntimeRepoSummary = {
  id: string
  connectionId?: string | null
}

export type MobileDisplayMode = 'auto' | 'phone' | 'desktop'

export type TerminalGestureInputBucket = {
  tokens: number
  lastRefillMs: number
}

export type TerminalGestureInputQueue = {
  bytes: string
  sequenceCount: number
  timer: ReturnType<typeof setTimeout> | null
  lastUpdatedMs: number
}

export type MarkdownReaderProps = {
  documentId: string
  doc: MarkdownDocState | undefined
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onDiscard: () => void
  keyboardLift: number
}

export type DiffLineRowProps = {
  line: RenderableDiffLine
  title: string
  index: number
  comments: DiffComment[]
  activeCommentLine: number | null
  commentDraft: string
  commentsBusy: boolean
  onStartComment: (lineNumber: number) => void
  onCancelComment: () => void
  onDraftChange: (value: string) => void
  onSubmitComment: (lineNumber: number) => void
  onDeleteComment: (commentId: string) => void
}

export type FileReaderProps = {
  doc: FileDocState | undefined
  title: string
  relativePath: string
  language?: string
  diffCommentActions?: DiffCommentActions
}

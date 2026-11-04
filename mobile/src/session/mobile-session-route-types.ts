import type { MobileFileMedia } from '../files/mobile-file-media'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionAgentTabStatus,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTerminalTab
} from '../../../src/shared/runtime-types'
import type { MirroredEvidenceReceipt } from '../../../src/shared/agent-status-observation'
import type { MobileDiffLine } from './mobile-diff-lines'
import type { MobileHighlightedDiffLine, MobileSyntaxSegment } from './mobile-file-syntax'
import type { TerminalRecord } from './mobile-terminal-records'
import type { MobileNativeChatIdentity } from './native-chat/mobile-native-chat-eligibility'

export type Terminal = TerminalRecord

export type MobileBrowserTab = Pick<
  RuntimeMobileSessionBrowserTab,
  | 'type'
  | 'id'
  | 'title'
  | 'browserWorkspaceId'
  | 'browserPageId'
  | 'url'
  | 'loading'
  | 'loadError'
  | 'canGoBack'
  | 'canGoForward'
  | 'isActive'
>

export type MobileSessionTabType = NonNullable<RuntimeMobileSessionTabsResult['activeTabType']>

/** What the phone adds to a host terminal tab; a type test keeps these names off the host's tab. */
export type MobileTerminalTabPhoneFields = {
  // Carried across publications so chat stays open before live agent status arrives.
  nativeChatIdentity?: MobileNativeChatIdentity
}

// The phone reads a subset of each host tab; fields older hosts omit are optional here.
export type MobileSessionTab =
  | (Pick<RuntimeMobileSessionTerminalTab, 'type' | 'id' | 'title' | 'isActive'> &
      Partial<
        Pick<
          RuntimeMobileSessionTerminalTab,
          | 'parentTabId'
          | 'leafId'
          | 'agentStatus'
          | 'launchAgent'
          | 'launchDraft'
          | 'launchDraftCreatedAt'
          | 'terminalTheme'
        >
      > & {
        status?: RuntimeMobileSessionTerminalClientTab['status']
        terminal: string | null
      } & MobileTerminalTabPhoneFields)
  | (Pick<
      RuntimeMobileSessionAgentTab,
      'type' | 'id' | 'title' | 'sessionId' | 'agent' | 'isActive'
    > & {
      chatStatus?: RuntimeMobileSessionAgentTabStatus & MirroredEvidenceReceipt
    })
  | Pick<
      RuntimeMobileSessionMarkdownTab,
      | 'type'
      | 'id'
      | 'title'
      | 'filePath'
      | 'relativePath'
      | 'isDirty'
      | 'isActive'
      | 'documentVersion'
    >
  | (Pick<
      RuntimeMobileSessionFileTab,
      | 'type'
      | 'id'
      | 'title'
      | 'filePath'
      | 'relativePath'
      | 'mode'
      | 'oldPath'
      | 'isDirty'
      | 'isActive'
    > & {
      language?: string
      // The phone also opens branch and commit diffs, which the host never publishes.
      diffSource?: RuntimeMobileSessionFileTab['diffSource'] | 'branch' | 'commit'
    })
  | MobileBrowserTab

export type SessionTabsResult = Pick<
  RuntimeMobileSessionTabsResult,
  | 'worktree'
  | 'clientHostedPagesUnreconciled'
  | 'agentSessionsUnverifiable'
  | 'snapshotVersion'
  | 'activeTabId'
  | 'activeTabType'
  | 'navigationIntent'
> &
  Partial<Pick<RuntimeMobileSessionTabsResult, 'publicationEpoch'>> & {
    tabs: MobileSessionTab[]
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

export type MobileNewTabAgentLoadState = 'idle' | 'loading' | 'loaded' | 'error' | 'other-runtime'

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

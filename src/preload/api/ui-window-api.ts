import type { AgentSessionAttachmentClipboardTarget } from '../../shared/agent-session-attachments'
import type { ClipboardImageThumbnail } from '../../shared/clipboard-image'
import type { ReadClipboardTextOptions } from '../../shared/clipboard-text'
import type {
  RichMarkdownContextMenuCommandPayload,
  RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'

export type UiWindowApi = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  saveClipboardImageAsTempFile: (args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
    /** A native-chat composer paste, kept where its draft can bring it back. */
    forNativeChatDraft?: boolean
    /** With `forNativeChatDraft`: a structured chat on this machine, whose sends claim its pastes. */
    forStructuredChat?: boolean
  }) => Promise<string | null>
  /** A long text paste saved as a file the chat's agent reads: here, or in its paired server's store. */
  savePastedTextAsFile: (args: {
    text: string
    runtimeEnvironmentId?: string | null
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  }) => Promise<string>
  clipboardHasImage: () => Promise<boolean | null>
  /** Paths of files a file manager copied; empty when there are none or the host cannot list them. */
  readClipboardFilePaths: () => Promise<string[]>
  /** Which restored draft pastes are still kept: files really in Orca's paste folder. */
  restoreNativeChatPastes: (
    paths: string[]
  ) => Promise<{ path: string; kept: boolean; exists: boolean }[]>
  /** A sweep tried to remove this chat-attachment upload folder; drafts naming it check again. */
  onAgentSessionUploadRemoved: (callback: (uploadDir: string) => void) => () => void
  readClipboardImageThumbnail: () => Promise<ClipboardImageThumbnail | null>
  writeClipboardText: (text: string) => Promise<void>
  writeTerminalClipboardText: (text: string) => Promise<void>
  writeSelectionClipboardText: (text: string) => Promise<void>
  writeClipboardImage: (dataUrl: string) => Promise<void>
  performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
  performNativeSelectionAction: (action: 'copy' | 'select-all') => void
  writeClipboardFile: (
    args:
      | {
          filePath: string
          connectionId?: string | null
        }
      | string
  ) => Promise<{ ok: boolean; reason?: string }>
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
  syncTrafficLights: (zoomFactor: number) => void
  setMarkdownEditorFocused: (focused: boolean) => void
  setRichMarkdownContextMenuTarget: (target: RichMarkdownContextMenuTableTarget | null) => void
  /** The next editable context menu opens on plain text, not a rich Markdown editor. */
  markPlainTextContextMenuTarget: () => void
  setTerminalInputFocused: (focused: boolean) => void
  setFloatingFocus: (state: { panelFocused: boolean; terminalFocused: boolean }) => void
  setShortcutRecorderFocused: (focused: boolean) => void
  onRichMarkdownContextCommand: (
    callback: (payload: RichMarkdownContextMenuCommandPayload) => void
  ) => () => void
  onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
  minimize: () => void
  maximize: () => void
  isMaximized: () => Promise<boolean>
  onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
  requestClose: () => void
  popupMenu: () => void
  onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
  confirmWindowClose: () => void
  notifyWindowRevealed: () => void
}

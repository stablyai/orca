import type { AgentSessionAttachmentClipboardTarget } from '../../../shared/agent-session/agent-session-attachments'
import type { ClipboardImageThumbnail } from '../../../shared/clipboard/clipboard-image'
import type { ReadClipboardTextOptions } from '../../../shared/clipboard/clipboard-text'
import type {
  RichMarkdownContextMenuCommandPayload,
  RichMarkdownContextMenuTableTarget
} from '../../../shared/editor/markdown/rich-markdown-context-menu'

export type UiWindowApi = {
  // Lives here because ui-command-event-api.ts is at its line cap.
  onDeleteCurrentWorkspace: (callback: () => void) => () => void
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  /** The clipboard's HTML when it may carry links; empty otherwise. */
  readClipboardLinkHtml: () => Promise<string>
  readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  saveClipboardImageAsTempFile: (args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
    /** A native-chat composer paste, kept where its draft can bring it back. */
    forNativeChatDraft?: boolean
    /** With `forNativeChatDraft`: a structured chat on this machine, whose sends claim its pastes. */
    forStructuredChat?: boolean
    /** Web client only: the paste event's picture, since insecure origins have no async clipboard. */
    eventImage?: Blob
  }) => Promise<string | null>
  /** Saves paste text on the execution host so the agent can read it. */
  savePastedTextAsFile: (args: {
    text: string
    runtimeEnvironmentId?: string | null
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  }) => Promise<string>
  clipboardHasImage: () => Promise<boolean | null>
  /** Empty if no files were copied or the host cannot list them. */
  readClipboardFilePaths: () => Promise<string[]>
  /** Only files inside Orca's paste folder count as kept. */
  restoreNativeChatPastes: (
    paths: string[]
  ) => Promise<{ path: string; kept: boolean; exists: boolean }[]>
  /** A sweep tried to remove this chat-attachment upload folder; drafts naming it check again. */
  onAgentSessionUploadRemoved: (callback: (uploadDir: string) => void) => () => void
  readClipboardImageThumbnail: () => Promise<ClipboardImageThumbnail | null>
  writeClipboardText: (text: string) => Promise<void>
  writeTerminalClipboardText: (text: string) => Promise<void>
  /** For a secret: cleared after a minute if it's still there; clearsLater false where that isn't promised. */
  writeSecretClipboardText: (text: string) => Promise<{ clearsLater: boolean }>
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
  /** Focused, shown and not minimized, from the window itself. */
  isWindowActive: () => Promise<boolean>
  onWindowActiveChanged: (callback: (active: boolean) => void) => () => void
  requestClose: () => void
  popupMenu: () => void
  onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
  confirmWindowClose: () => void
  /** The user kept the window after a close request, which also cancels a pending quit. */
  cancelWindowClose: () => void
  notifyWindowRevealed: () => void
}

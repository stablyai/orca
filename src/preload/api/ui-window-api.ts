import type { ClipboardImageThumbnail } from '../../shared/clipboard-image'
import type { ReadClipboardTextOptions } from '../../shared/clipboard-text'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'
import type {
  RichMarkdownContextMenuCommandPayload,
  RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import type { WorkspaceWindowMetadata } from '../../shared/workspace-window-metadata'

export type UiWindowApi = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  saveClipboardImageAsTempFile: (args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
    /** A native-chat composer paste, kept where its draft can bring it back. */
    forNativeChatDraft?: boolean
  }) => Promise<string | null>
  clipboardHasImage: () => Promise<boolean | null>
  /** Paths of files a file manager copied; empty when there are none or the host cannot list them. */
  readClipboardFilePaths: () => Promise<string[]>
  /** Which restored draft pastes are still kept: files really in Orca's paste folder. */
  restoreNativeChatPastes: (
    paths: string[]
  ) => Promise<{ path: string; kept: boolean; exists: boolean }[]>
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
  onFileDrop: (callback: (data: NativeFileDropPayload) => void) => () => void
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
  syncTrafficLights: (zoomFactor: number) => void
  setWorkspaceWindowMetadata: (metadata: WorkspaceWindowMetadata) => void
  setMarkdownEditorFocused: (focused: boolean) => void
  setRichMarkdownContextMenuTarget: (target: RichMarkdownContextMenuTableTarget | null) => void
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

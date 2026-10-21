// A file open main makes itself in a layout-owner build (CLI, phone, a host with no window): main
// writes the editor tab, opening it in the group the window last reported, and a window, if one is
// attached, only shows it. A paired server's workspace keeps today's window open.

import { randomUUID } from 'node:crypto'
import { detectLanguage } from '../../../shared/editor-language/editor-language-detect'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type {
  RuntimeEditorFileOpen,
  RuntimeEditorTabReveal
} from '../../../shared/runtime-file-contracts'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import type { RuntimeNotifier } from '../runtime-notifier-contract'
import type { RuntimeFileCommandHost } from './file-command-host'
import { isChatScratchWorktreeId } from './chat-scratch-file-root'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'

export type EditorFileOpen = RuntimeEditorFileOpen

export type EditorOpenHost = {
  applyLayoutCommand: (command: WindowLayoutCommand) => Promise<LayoutApplyReply>
  /** The group the window last reported for the workspace, else its saved view's. */
  groupFor: (worktreeId: string) => string | undefined
  /** Shows main's tab in an attached window; absent with no window. */
  revealEditorTab?: (reveal: RuntimeEditorTabReveal) => void
  /** Today's open, through the window: a paired server owns the workspace's layout. */
  openInWindow: (open: EditorFileOpen) => void
  publishHeadlessTabs?: (worktreeId: string) => void
}

export function createRuntimeEditorFileOpener(
  host: Pick<EditorOpenHost, 'applyLayoutCommand' | 'groupFor' | 'publishHeadlessTabs'> & {
    getNotifier(): RuntimeNotifier | null | undefined
  }
): RuntimeFileCommandHost['openFile'] {
  return async (worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation, position) => {
    if (isChatScratchWorktreeId(worktreeId)) {
      throw new Error('chat_scratch_not_openable')
    }
    const notifier = host.getNotifier()
    const open = { worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation, position }
    if (ORCA_LAYOUT_OWNER_IS_MAIN || !notifier?.openFile) {
      await openEditorFileThroughLayoutOwner(
        {
          ...host,
          revealEditorTab: (shown) => notifier?.revealEditorTab?.(shown),
          openInWindow: (inWindow) => openEditorFileInWindow(notifier, inWindow)
        },
        open
      )
      if (!notifier?.openFile) {
        host.publishHeadlessTabs?.(worktreeId)
      }
    } else {
      openEditorFileInWindow(notifier, open)
    }
  }
}

export async function openEditorFileThroughLayoutOwner(
  host: EditorOpenHost,
  open: EditorFileOpen
): Promise<void> {
  const basename = open.relativePath.split(/[\\/]/).pop() || open.relativePath
  const runtimeEnvironmentId = open.runtimeEnvironmentId?.trim()
  const command: WindowLayoutCommand = {
    type: 'openEditorTab',
    workspace: open.worktreeId,
    tabId: randomUUID(),
    contentType: 'editor',
    file: {
      filePath: open.filePath,
      relativePath: open.relativePath,
      language: detectLanguage(basename),
      ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
    },
    createdAt: Date.now()
  }
  const groupId = host.groupFor(open.worktreeId)
  let reply = await host.applyLayoutCommand(groupId ? { ...command, groupId } : command)
  // A group closed since the window reported it: open where main's own rule places it.
  if (!reply.ok && reply.code === 'group_not_found' && groupId) {
    reply = await host.applyLayoutCommand(command)
  }
  if (!reply.ok) {
    if (reply.code === 'host_not_owned') {
      host.openInWindow(open)
      return
    }
    throw new Error(`editor_open_refused: ${reply.code}`)
  }
  const tabId = reply.result.tabId
  if (tabId) {
    host.revealEditorTab?.({ ...open, tabId, frameSeq: reply.frameSeq })
  }
}

/** Today's open: the window draws the tab. */
export function openEditorFileInWindow(
  notifier: Pick<RuntimeNotifier, 'openFile'> | null | undefined,
  open: EditorFileOpen
): void {
  if (!notifier?.openFile) {
    throw new Error('renderer_unavailable')
  }
  notifier.openFile(
    open.worktreeId,
    open.filePath,
    open.relativePath,
    open.runtimeEnvironmentId,
    open.navigation,
    ...(open.position ? [open.position] : [])
  )
}

import type { RuntimeNativeChatFileContext } from '../../../src/shared/runtime-types'
import { filesystemPathToFileUri } from '../../../src/shared/file-uri-path'
import { createMobileFilePreviewHref } from '../files/mobile-file-preview-route'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import type { HostSessionTerminalFileOperations } from './host-session-terminal-file-operations'
import { shouldActivateOpenedMobileSessionTab } from './opened-mobile-session-tab'

export type FileTapSessionTab = {
  id: string
  relativePath?: string
}

export type OpenMobileFileTapOptions<T extends FileTapSessionTab> = {
  operations: HostSessionTerminalFileOperations
  hostId: string
  worktreeId: string
  worktreeName?: string
  terminalHandle?: string | null
  pathText: string
  cwd?: string | null
  nativeChatContext?: RuntimeNativeChatFileContext | null
  line: number | null
  column: number | null
  pushPreviewRoute: (href: ReturnType<typeof createMobileFilePreviewHref>) => void
  openBrowser: (url: string) => void
  triggerOpenFeedback: () => void
  fetchSessionTabs: () => Promise<void>
  getSessionTabs: () => readonly T[]
  getActiveSessionTabId: () => string | null
  getActivationState: (activated: boolean) => {
    activated: boolean
    activationSeq: number
    latestActivationSeq: number
    sourceTerminalHandle: string | null
    activeTerminalHandle: string | null
    sourceSessionTabId?: string | null
    activeSessionTabId?: string | null
    activeTabType: string | null
  }
  switchSessionTab: (tab: T) => void
  scheduleDelayedAction: (callback: () => void, delayMs: number) => unknown
  /** Invoked when the tap cannot open anything (resolve miss, directory, or a
   *  failed open). Omitted on surfaces that keep the historical silent miss. */
  onOpenFailed?: () => void
}

export function openMobileFileTap<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>
): void {
  void openMobileFileTapAsync(options).catch(() => {
    // File taps are best-effort: a failed host resolution should leave terminal
    // focus/input untouched. Surfaces that want feedback pass onOpenFailed.
    reportOpenFailure(options)
  })
}

function reportOpenFailure<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>
): void {
  if (
    options.onOpenFailed &&
    shouldActivateOpenedMobileSessionTab(options.getActivationState(false))
  ) {
    options.onOpenFailed()
  }
}

async function openMobileFileTapAsync<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>
): Promise<void> {
  const terminalHandle = options.terminalHandle?.trim()
  const activation = options.getActivationState(false)
  // Structured agent-session chat has no backing terminal; its tab id anchors the resolve.
  const sourceTabId =
    terminalHandle || activation.sourceTerminalHandle || activation.sourceSessionTabId
  if (!sourceTabId) {
    return
  }
  const resolved = await options.operations.resolveTerminalPath({
    workspaceId: options.worktreeId,
    tabId: sourceTabId,
    terminalHandle: terminalHandle || null,
    pathText: options.pathText,
    cwd: options.cwd?.trim() || null,
    nativeChatContext: options.nativeChatContext ?? null,
    line: options.line,
    column: options.column
  })
  if (!resolved) {
    reportOpenFailure(options)
    return
  }
  // Not a failure: the user moved off the source tab mid-resolve.
  if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(false))) {
    return
  }
  const resolvedWorktreeId = resolved.workspaceId?.trim() || options.worktreeId
  const resolvedWorktreeName =
    resolvedWorktreeId === options.worktreeId ? options.worktreeName : undefined

  if (resolved.kind === 'native-artifact') {
    triggerMobileTerminalOpenFeedback(options.triggerOpenFeedback)
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: resolvedWorktreeId,
        source: 'terminalArtifact',
        absolutePath: resolved.absolutePath,
        grantId: resolved.grantId,
        pathText: options.pathText,
        ...(options.cwd && options.cwd.trim().length > 0 ? { cwd: options.cwd } : {}),
        ...(options.terminalHandle && options.terminalHandle.trim().length > 0
          ? { terminal: options.terminalHandle }
          : {}),
        ...(options.nativeChatContext
          ? {
              nativeChatTab: options.nativeChatContext.tabId,
              nativeChatSession: options.nativeChatContext.sessionId
            }
          : {}),
        name: displayNameFromPath(resolved.absolutePath),
        ...(options.line !== null ? { line: String(options.line) } : {}),
        ...(options.column !== null ? { column: String(options.column) } : {}),
        ...(resolvedWorktreeName ? { worktreeName: resolvedWorktreeName } : {})
      })
    )
    return
  }
  if (resolved.kind === 'web-artifact') {
    return
  }

  const openedPath = resolved.relativePath
  triggerMobileTerminalOpenFeedback(options.triggerOpenFeedback)
  // A sibling-workspace hit has no tab in this session to open into, so it must go
  // to the preview route addressed at the workspace that actually holds the file.
  if (
    resolvedWorktreeId !== options.worktreeId ||
    options.line !== null ||
    options.column !== null
  ) {
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: resolvedWorktreeId,
        source: 'worktree',
        relativePath: openedPath,
        name: displayNameFromPath(openedPath),
        ...(options.line !== null ? { line: String(options.line) } : {}),
        ...(options.column !== null ? { column: String(options.column) } : {}),
        ...(resolvedWorktreeName ? { worktreeName: resolvedWorktreeName } : {})
      })
    )
    return
  }
  if (classifyMobileArtifact(openedPath) === 'html' && resolved.localAbsolutePath) {
    options.openBrowser(filesystemPathToFileUri(resolved.localAbsolutePath))
    return
  }
  await options.operations.openWorktreeFile(resolvedWorktreeId, openedPath)
  scheduleOpenedWorktreeTabActivation(options, openedPath)
}

function scheduleOpenedWorktreeTabActivation<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  openedPath: string
): void {
  let activated = false
  const activateOpenedTab = async (): Promise<void> => {
    if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(activated))) {
      return
    }
    await options.fetchSessionTabs()
    if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(activated))) {
      return
    }
    const opened = options.getSessionTabs().find((tab) => tab.relativePath === openedPath)
    if (!opened) {
      return
    }
    if (options.getActiveSessionTabId() !== opened.id) {
      options.switchSessionTab(opened)
    }
    activated = true
  }

  options.scheduleDelayedAction(() => void activateOpenedTab(), 300)
  options.scheduleDelayedAction(() => void activateOpenedTab(), 900)
  options.scheduleDelayedAction(() => void activateOpenedTab(), 1800)
}

function displayNameFromPath(path: string): string | undefined {
  return path.split(/[\\/]/).findLast(Boolean)
}

function triggerMobileTerminalOpenFeedback(trigger: () => void): void {
  try {
    trigger()
  } catch {
    // Optional tactile feedback must not block the requested navigation.
  }
}

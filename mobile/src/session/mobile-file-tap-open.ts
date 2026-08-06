import type {
  RuntimeFileOpenResult,
  RuntimeTerminalPathResolution
} from '../../../src/shared/runtime-types'
import { filesystemPathToFileUri } from '../../../src/shared/file-uri-path'
import { createMobileFilePreviewHref } from '../files/mobile-file-preview-route'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { shouldActivateOpenedMobileSessionTab } from './opened-mobile-session-tab'

export type FileTapSessionTab = {
  id: string
  relativePath?: string
}

export type OpenMobileFileTapOptions<T extends FileTapSessionTab> = {
  client: Pick<RpcClient, 'sendRequest'>
  hostId: string
  worktreeId: string
  worktreeName?: string
  terminalHandle?: string | null
  pathText: string
  cwd?: string | null
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
    sourceTerminalHandle: string
    activeTerminalHandle: string | null
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
  const worktree = `id:${options.worktreeId}`
  const response = await options.client.sendRequest(
    'files.resolveTerminalPath',
    {
      worktree,
      pathText: options.pathText,
      // Why: opts into sibling-workspace resolutions; this caller honors resolved.worktree.
      crossWorkspace: true,
      ...(options.terminalHandle && options.terminalHandle.trim().length > 0
        ? { terminal: options.terminalHandle }
        : {}),
      ...(options.cwd && options.cwd.trim().length > 0 ? { cwd: options.cwd } : {})
    },
    { timeoutMs: 10_000 }
  )
  if (!response.ok) {
    reportOpenFailure(options)
    return
  }
  const resolved = (response as RpcSuccess).result as RuntimeTerminalPathResolution
  if (!resolved.exists || resolved.isDirectory) {
    reportOpenFailure(options)
    return
  }
  // Not a failure: the user moved off the source tab mid-resolve.
  if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(false))) {
    return
  }
  const resolvedWorktreeId = resolved.worktree?.trim() || options.worktreeId
  const resolvedWorktree = `id:${resolvedWorktreeId}`
  const resolvedWorktreeName =
    resolvedWorktreeId === options.worktreeId ? options.worktreeName : undefined

  if (resolved.openTarget?.kind === 'absolute-file') {
    options.triggerOpenFeedback()
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: resolvedWorktreeId,
        source: 'terminalArtifact',
        absolutePath: resolved.openTarget.absolutePath,
        grantId: resolved.openTarget.grantId,
        pathText: options.pathText,
        ...(options.cwd && options.cwd.trim().length > 0 ? { cwd: options.cwd } : {}),
        ...(options.terminalHandle && options.terminalHandle.trim().length > 0
          ? { terminal: options.terminalHandle }
          : {}),
        name: displayNameFromPath(resolved.openTarget.absolutePath),
        ...(options.line !== null ? { line: String(options.line) } : {}),
        ...(options.column !== null ? { column: String(options.column) } : {}),
        ...(resolvedWorktreeName ? { worktreeName: resolvedWorktreeName } : {})
      })
    )
    return
  }

  const openedPath =
    resolved.openTarget?.kind === 'worktree-file'
      ? resolved.openTarget.relativePath
      : resolved.relativePath
  if (!openedPath) {
    reportOpenFailure(options)
    return
  }
  options.triggerOpenFeedback()
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
  if (
    classifyMobileArtifact(openedPath) === 'html' &&
    resolved.openTarget?.kind === 'worktree-file' &&
    resolved.openTarget.provider === 'local'
  ) {
    options.openBrowser(filesystemPathToFileUri(resolved.openTarget.absolutePath))
    return
  }
  const openResponse = await options.client.sendRequest(
    'files.open',
    { worktree: resolvedWorktree, relativePath: openedPath },
    { timeoutMs: 15_000 }
  )
  if (!openResponse.ok) {
    reportOpenFailure(options)
    return
  }
  const openResult = (openResponse as RpcSuccess).result as RuntimeFileOpenResult
  if (!openResult.opened) {
    reportOpenFailure(options)
    return
  }
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

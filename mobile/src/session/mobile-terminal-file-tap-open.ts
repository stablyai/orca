import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import { filesystemPathToFileUri } from '../../../src/shared/file-uri-path'
import { createMobileFilePreviewHref } from '../files/mobile-file-preview-route'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { shouldActivateOpenedMobileSessionTab } from './opened-mobile-session-tab'

type TerminalFileTapSessionTab = {
  id: string
  relativePath?: string
}

type OpenMobileTerminalFileTapOptions<T extends TerminalFileTapSessionTab> = {
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
}

export function openMobileTerminalFileTap<T extends TerminalFileTapSessionTab>(
  options: OpenMobileTerminalFileTapOptions<T>
): void {
  void openMobileTerminalFileTapAsync(options).catch(() => {
    // Terminal file taps are best-effort: a failed host resolution should leave
    // terminal focus/input untouched, matching the existing silent miss behavior.
  })
}

async function openMobileTerminalFileTapAsync<T extends TerminalFileTapSessionTab>(
  options: OpenMobileTerminalFileTapOptions<T>
): Promise<void> {
  const worktree = `id:${options.worktreeId}`
  const response = await options.client.sendRequest(
    'files.resolveTerminalPath',
    {
      worktree,
      pathText: options.pathText,
      ...(options.terminalHandle && options.terminalHandle.trim().length > 0
        ? { terminal: options.terminalHandle }
        : {}),
      ...(options.cwd && options.cwd.trim().length > 0 ? { cwd: options.cwd } : {})
    },
    { timeoutMs: 10_000 }
  )
  if (!response.ok) {
    return
  }
  const resolved = (response as RpcSuccess).result as RuntimeTerminalPathResolution
  if (!resolved.exists || resolved.isDirectory) {
    return
  }
  if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(false))) {
    return
  }

  if (resolved.openTarget?.kind === 'absolute-file') {
    options.triggerOpenFeedback()
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: options.worktreeId,
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
        ...(options.worktreeName ? { worktreeName: options.worktreeName } : {})
      })
    )
    return
  }

  const openedPath =
    resolved.openTarget?.kind === 'worktree-file'
      ? resolved.openTarget.relativePath
      : resolved.relativePath
  if (!openedPath) {
    return
  }
  options.triggerOpenFeedback()
  if (options.line !== null || options.column !== null) {
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: options.worktreeId,
        source: 'worktree',
        relativePath: openedPath,
        name: displayNameFromPath(openedPath),
        ...(options.line !== null ? { line: String(options.line) } : {}),
        ...(options.column !== null ? { column: String(options.column) } : {}),
        ...(options.worktreeName ? { worktreeName: options.worktreeName } : {})
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
    { worktree, relativePath: openedPath },
    { timeoutMs: 15_000 }
  )
  if (!openResponse.ok) {
    return
  }
  scheduleOpenedWorktreeTabActivation(options, openedPath)
}

function scheduleOpenedWorktreeTabActivation<T extends TerminalFileTapSessionTab>(
  options: OpenMobileTerminalFileTapOptions<T>,
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

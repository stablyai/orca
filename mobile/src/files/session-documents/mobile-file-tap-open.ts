import type { ParsedFileLinkLocation } from '../../../../src/shared/file-links/file-link-location'
import type { RuntimeNativeChatFileContext } from '../../../../src/shared/native-chat/native-chat-file-context'
import type { RuntimeTerminalPathResolution } from '../../../../src/shared/terminal/runtime-terminal-file-path'
import { filesystemPathToFileUri } from '../../../../src/shared/file-links/file-uri-path'
import { createMobileFilePreviewHref } from '../mobile-file-preview-route'
import { classifyMobileArtifact } from '../mobile-artifact-kind'
import { fileTapOpenRun } from './mobile-file-tap-operations'
import { terminalArtifactPathResolve as fileTapPathResolve } from '../mobile-file-preview-operations'
import { mapWithConcurrency } from '../../../../src/shared/map-with-concurrency'
import {
  shouldActivateOpenedMobileSessionTab,
  type OpenedMobileSessionTabActivationState
} from '../../session/tabs/opened-mobile-session-tab'
import { isRendererUnavailableReply } from '../../transport/rpc/renderer-unavailable-reply'
import type { RpcOperationSender } from '../../transport/rpc/rpc-operation-sender'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'

// Hard-wrap guesses can number in the hundreds; stay far below the page bridge's 64 pending requests.
const FILE_TAP_RESOLVE_CONCURRENCY = 8

export type FileTapSessionTab = {
  id: string
  relativePath?: string
}

export type MobileFileTapFailure = {
  kind: 'unresolved' | 'failed'
  pathText: string
  message?: string
}

export type OpenMobileFileTapOptions<T extends FileTapSessionTab> = {
  client: RpcOperationSender
  hostId: string
  worktreeId: string
  worktreeName?: string
  terminalHandle?: string | null
  cwd?: string | null
  nativeChatContext?: RuntimeNativeChatFileContext | null
  // Every reading of the tapped text; like desktop, the longest that exists opens.
  candidates: readonly ParsedFileLinkLocation[]
  pushPreviewRoute: (href: ReturnType<typeof createMobileFilePreviewHref>) => void
  openBrowser: (url: string) => void
  triggerOpenFeedback: () => void
  fetchSessionTabs: () => Promise<void>
  getSessionTabs: () => readonly T[]
  getActiveSessionTabId: () => string | null
  getActivationState: (activated: boolean) => OpenedMobileSessionTabActivationState
  switchSessionTab: (tab: T) => void
  scheduleDelayedAction: (callback: () => void, delayMs: number) => unknown
  // Callers choose whether unresolved guesses need feedback.
  onOpenFailed?: (failure: MobileFileTapFailure) => void
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

function requestFileTapResolution<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  pathText: string
) {
  return fileTapPathResolve.request(
    options.client,
    {
      worktree: `id:${options.worktreeId}`,
      pathText,
      // Why: opts into sibling-workspace resolutions; this caller honors resolved.worktree.
      crossWorkspace: true,
      ...(options.terminalHandle && options.terminalHandle.trim().length > 0
        ? { terminal: options.terminalHandle }
        : {}),
      ...(options.cwd && options.cwd.trim().length > 0 ? { cwd: options.cwd } : {}),
      ...(options.nativeChatContext ? { nativeChatContext: options.nativeChatContext } : {})
    },
    { timeoutMs: 10_000 }
  )
}

function existingFileTapResolution(
  response: RpcResponse | null
): RuntimeTerminalPathResolution | null {
  const accepted = response ? fileTapPathResolve.interpret(response) : null
  if (!accepted?.accepted) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  const resolved = accepted.value as RuntimeTerminalPathResolution
  return resolved.exists && !resolved.isDirectory ? resolved : null
}

function reportOpenFailure<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  failure: MobileFileTapFailure = {
    kind: 'failed',
    pathText: options.candidates[0]?.pathText ?? ''
  }
): void {
  if (
    options.onOpenFailed &&
    shouldActivateOpenedMobileSessionTab(options.getActivationState(false))
  ) {
    options.onOpenFailed(failure)
  }
}

async function openMobileFileTapAsync<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>
): Promise<void> {
  const readings = await mapWithConcurrency(
    options.candidates,
    FILE_TAP_RESOLVE_CONCURRENCY,
    async (target) => {
      // Why: a reading the host cannot answer must not hide a sibling.
      const response = await requestFileTapResolution(options, target.pathText).catch(() => null)
      return { target, response, resolved: existingFileTapResolution(response) }
    }
  )
  const found = readings.reduce<(typeof readings)[number] | undefined>(
    (best, reading) =>
      reading.resolved && (!best || reading.target.pathText.length > best.target.pathText.length)
        ? reading
        : best,
    undefined
  )
  if (!found?.resolved) {
    const refused = readings.find((reading) => reading.response && !reading.response.ok)
    reportOpenFailure(options, {
      kind: refused ? 'failed' : 'unresolved',
      pathText: (refused?.target ?? options.candidates[0])?.pathText ?? '',
      message: refused?.response?.ok === false ? refused.response.error.message : undefined
    })
    return
  }
  await openResolvedMobileFileTap(options, found.target, found.resolved).catch(() =>
    reportOpenFailure(options, { kind: 'failed', pathText: found.target.pathText })
  )
}

async function openResolvedMobileFileTap<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  target: ParsedFileLinkLocation,
  resolved: RuntimeTerminalPathResolution
): Promise<void> {
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
        pathText: target.pathText,
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
        name: displayNameFromPath(resolved.openTarget.absolutePath),
        ...(target.line !== null ? { line: String(target.line) } : {}),
        ...(target.column !== null ? { column: String(target.column) } : {}),
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
    reportOpenFailure(options, { kind: 'failed', pathText: target.pathText })
    return
  }
  options.triggerOpenFeedback()
  const pushWorktreePreview = (): void =>
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: resolvedWorktreeId,
        source: 'worktree',
        relativePath: openedPath,
        name: displayNameFromPath(openedPath),
        ...(target.line !== null ? { line: String(target.line) } : {}),
        ...(target.column !== null ? { column: String(target.column) } : {}),
        ...(resolvedWorktreeName ? { worktreeName: resolvedWorktreeName } : {})
      })
    )
  if (resolvedWorktreeId !== options.worktreeId || target.line !== null || target.column !== null) {
    pushWorktreePreview()
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
  const openResponse = await fileTapOpenRun.request(
    options.client,
    { worktree: resolvedWorktree, relativePath: openedPath },
    { timeoutMs: 15_000 }
  )
  // Why: a host with no desktop window opens no editor tabs; the preview route reads the file through files.read.
  if (isRendererUnavailableReply(openResponse)) {
    // Not a failure: the user moved off the source tab during the call.
    if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(false))) {
      return
    }
    pushWorktreePreview()
    return
  }
  const opened = fileTapOpenRun.interpret(openResponse)
  if (!opened.accepted) {
    reportOpenFailure(options, {
      kind: 'failed',
      pathText: target.pathText,
      message: openResponse.ok ? undefined : openResponse.error.message
    })
    return
  }
  if (!opened.value.opened) {
    reportOpenFailure(options, { kind: 'failed', pathText: target.pathText })
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

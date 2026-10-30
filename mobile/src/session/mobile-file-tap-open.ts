import type { ParsedFileLinkLocation } from '../../../src/shared/file-link-location'
import type {
  RuntimeNativeChatFileContext,
  RuntimeTerminalPathResolution
} from '../../../src/shared/runtime-types'
import { filesystemPathToFileUri } from '../../../src/shared/file-uri-path'
import { createMobileFilePreviewHref } from '../files/mobile-file-preview-route'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import { resolveMissingTerminalFileTap } from './mobile-file-tap-fallback-resolve'
import { fileTapOpenRun, fileTapPathResolve } from './mobile-session-launch-operations'
import { mapWithConcurrency } from '../../../src/shared/map-with-concurrency'
import { shouldActivateOpenedMobileSessionTab } from './opened-mobile-session-tab'
import { isRendererUnavailableReply } from '../transport/renderer-unavailable-reply'
import type { RpcResponse } from '../transport/types'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

// Hard-wrap guesses can number in the hundreds; stay far below the page bridge's 64 pending requests.
const FILE_TAP_RESOLVE_CONCURRENCY = 8

export type FileTapSessionTab = {
  id: string
  relativePath?: string
  filePath?: string
}

export type MobileFileTapResolvedConfirmation = {
  title: string
  displayPath: string
  copyPath: string
}

export type OpenMobileFileTapOptions<T extends FileTapSessionTab> = {
  client: RpcOperationSender
  hostId: string
  worktreeId: string
  worktreeName?: string
  terminalHandle?: string | null
  cwd?: string | null
  nativeChatContext?: RuntimeNativeChatFileContext | null
  pathText?: string
  line?: number | null
  column?: number | null
  // Every reading of the tapped text; like desktop, the longest that exists opens.
  candidates?: readonly ParsedFileLinkLocation[]
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
  // Optional feedback; callers without it retain silent best-effort misses.
  onOpenFailed?: () => void
  /** Optional confirmation hook invoked once the host confirms the tapped path
   *  is an existing file. Calling `proceed` completes the open without a second
   *  resolve round-trip. */
  confirmResolvedOpen?: (target: MobileFileTapResolvedConfirmation, proceed: () => void) => void
  onRevealFileLine?: (relativePath: string, line: number) => void
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

function interpretFileTapResolution(
  response: RpcResponse | null
): RuntimeTerminalPathResolution | null {
  const accepted = response ? fileTapPathResolve.interpret(response) : null
  if (!accepted?.accepted) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return accepted.value as RuntimeTerminalPathResolution
}

function mobileFileTapReadings<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>
): readonly ParsedFileLinkLocation[] {
  if (options.candidates && options.candidates.length > 0) {
    return options.candidates
  }
  if (options.pathText) {
    return [
      {
        pathText: options.pathText,
        line: options.line ?? null,
        column: options.column ?? null
      }
    ]
  }
  return []
}

function withFileTapLocation<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  target: ParsedFileLinkLocation
): OpenMobileFileTapOptions<T> {
  return {
    ...options,
    pathText: target.pathText,
    line: target.line,
    column: target.column
  }
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
  const readings = await mapWithConcurrency(
    mobileFileTapReadings(options),
    FILE_TAP_RESOLVE_CONCURRENCY,
    async (target) => {
      const resolution = interpretFileTapResolution(
        await requestFileTapResolution(options, target.pathText).catch(() => null)
      )
      return {
        target,
        resolution,
        // Why: a reading the host cannot answer must not hide a sibling.
        resolved: resolution?.exists && !resolution.isDirectory ? resolution : null
      }
    }
  )
  let found = readings.reduce<(typeof readings)[number] | undefined>(
    (best, reading) =>
      reading.resolved && (!best || reading.target.pathText.length > best.target.pathText.length)
        ? reading
        : best,
    undefined
  )
  if (!found?.resolved) {
    const miss = readings.reduce<(typeof readings)[number] | undefined>(
      (best, reading) =>
        reading.resolution &&
        !reading.resolution.exists &&
        !reading.resolution.isDirectory &&
        (!best || reading.target.pathText.length > best.target.pathText.length)
          ? reading
          : best,
      undefined
    )
    if (
      miss?.resolution &&
      shouldActivateOpenedMobileSessionTab(options.getActivationState(false))
    ) {
      const recovered = await resolveMissingTerminalFileTap(
        withFileTapLocation(options, miss.target),
        miss.resolution
      )
      if (recovered?.exists && !recovered.isDirectory) {
        found = { ...miss, resolution: recovered, resolved: recovered }
      }
    }
  }
  if (!found?.resolved) {
    reportOpenFailure(options)
    return
  }
  const { target } = found
  const resolved = found.resolved
  const located = withFileTapLocation(options, target)
  // Not a failure: the user moved off the source tab mid-resolve.
  if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(false))) {
    return
  }
  if (options.confirmResolvedOpen) {
    const targetAbsolutePath =
      resolved.openTarget && resolved.openTarget.kind !== 'unsupported'
        ? resolved.openTarget.absolutePath
        : null
    const displayBasePath =
      resolved.relativePath ||
      targetAbsolutePath ||
      resolved.absolutePath ||
      target.pathText
    const copyPath =
      targetAbsolutePath ||
      resolved.absolutePath ||
      resolved.relativePath ||
      target.pathText
    const locationSuffix =
      target.line !== null
        ? `:${target.line}${target.column !== null ? `:${target.column}` : ''}`
        : ''
    options.triggerOpenFeedback()
    options.confirmResolvedOpen(
      {
        title: displayNameFromPath(displayBasePath) ?? 'File',
        displayPath: `${displayBasePath}${locationSuffix}`,
        copyPath
      },
      () => {
        void completeResolvedMobileFileTapOpen(located, resolved, false).catch(() => {
          reportOpenFailure(located)
        })
      }
    )
    return
  }
  await completeResolvedMobileFileTapOpen(located, resolved, true)
}

async function completeResolvedMobileFileTapOpen<T extends FileTapSessionTab>(
  options: OpenMobileFileTapOptions<T>,
  resolved: RuntimeTerminalPathResolution,
  triggerFeedback: boolean
): Promise<void> {
  const resolvedWorktreeId = resolved.worktree?.trim() || options.worktreeId
  const resolvedWorktree = `id:${resolvedWorktreeId}`
  const resolvedWorktreeName =
    resolvedWorktreeId === options.worktreeId ? options.worktreeName : undefined
  const target = resolved.openTarget
  const isAbsoluteFile = target?.kind === 'absolute-file'
  const openedPath =
    target?.kind === 'absolute-file'
      ? target.absolutePath
      : target?.kind === 'worktree-file'
        ? target.relativePath
        : resolved.relativePath
  if (!openedPath) {
    reportOpenFailure(options)
    return
  }
  if (triggerFeedback) {
    options.triggerOpenFeedback()
  }

  const pushAbsolutePreview = (): void => {
    if (target?.kind !== 'absolute-file') {
      return
    }
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: resolvedWorktreeId,
        source: 'terminalArtifact',
        absolutePath: target.absolutePath,
        grantId: target.grantId,
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
        name: displayNameFromPath(target.absolutePath),
        ...(options.line != null ? { line: String(options.line) } : {}),
        ...(options.column != null ? { column: String(options.column) } : {}),
        ...(resolvedWorktreeName ? { worktreeName: resolvedWorktreeName } : {})
      })
    )
  }

  const pushWorktreePreview = (): void =>
    options.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: options.hostId,
        worktreeId: resolvedWorktreeId,
        source: 'worktree',
        relativePath: openedPath,
        name: displayNameFromPath(openedPath),
        ...(options.line != null ? { line: String(options.line) } : {}),
        ...(options.column != null ? { column: String(options.column) } : {}),
        ...(resolvedWorktreeName ? { worktreeName: resolvedWorktreeName } : {})
      })
    )
  if (isAbsoluteFile && options.nativeChatContext) {
    pushAbsolutePreview()
    return
  }

  if (resolvedWorktreeId !== options.worktreeId) {
    if (isAbsoluteFile) {
      pushAbsolutePreview()
    } else {
      pushWorktreePreview()
    }
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

  const openLine =
    options.line != null && Number.isSafeInteger(options.line) && options.line >= 1
      ? options.line
      : undefined
  const openPosition =
    openLine !== undefined
      ? {
          line: openLine,
          ...(options.column != null &&
          Number.isSafeInteger(options.column) &&
          options.column >= 1
            ? { column: options.column }
            : {})
        }
      : {}

  let openResponse: RpcResponse
  try {
    openResponse = await fileTapOpenRun.request(
      options.client,
      { worktree: resolvedWorktree, relativePath: openedPath, ...openPosition },
      { timeoutMs: 15_000 }
    )
  } catch (error) {
    if (isAbsoluteFile) {
      pushAbsolutePreview()
      return
    }
    throw error
  }

  // Why: a host with no desktop window opens no editor tabs; the preview route reads the file through files.read.
  if (isRendererUnavailableReply(openResponse)) {
    // Not a failure: the user moved off the source tab during the call.
    if (!shouldActivateOpenedMobileSessionTab(options.getActivationState(false))) {
      return
    }
    if (isAbsoluteFile) {
      pushAbsolutePreview()
    } else {
      pushWorktreePreview()
    }
    return
  }

  const opened = fileTapOpenRun.interpret(openResponse)
  if (!opened.accepted || !opened.value.opened) {
    if (isAbsoluteFile) {
      pushAbsolutePreview()
      return
    }
    reportOpenFailure(options)
    return
  }

  if (
    openLine !== undefined &&
    shouldActivateOpenedMobileSessionTab(options.getActivationState(false))
  ) {
    options.onRevealFileLine?.(openedPath, openLine)
  }
  scheduleOpenedWorktreeTabActivation(options, openedPath)
}

function matchesTabPath(candidate: unknown, target: string): boolean {
  if (typeof candidate !== 'string') {
    return false
  }
  if (candidate === target) {
    return true
  }
  return candidate.replace(/\\/g, '/').toLowerCase() === target.replace(/\\/g, '/').toLowerCase()
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
    const opened = options
      .getSessionTabs()
      .find(
        (tab) =>
          matchesTabPath(tab.relativePath, openedPath) || matchesTabPath(tab.filePath, openedPath)
      )
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

export function displayNameFromPath(path: string): string | undefined {
  return path.split(/[\\/]/).findLast(Boolean)
}

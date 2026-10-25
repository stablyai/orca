import type { WebContents } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'
import { nativeDesktopWindowGraphs } from '../runtime/native-desktop-window-graphs'
import { preferredDesktopRenderer } from './desktop-renderer-registry'
import { nativeDesktopNotifierReadiness } from './native-desktop-notifier-readiness'

type NativeNotifier = {
  window: NativeNotifierWindow
  notifier: RuntimeNotifier
  available: () => boolean
  recover?: () => boolean
}

type NativeNotifierWindow = {
  id: number
  isDestroyed: () => boolean
  webContents: Pick<WebContents, 'id'>
}

const broadcastMethods: ReadonlySet<string> = new Set<keyof RuntimeNotifier>([
  'worktreesChanged',
  'worktreeBaseStatus',
  'worktreeRemoteBranchConflict',
  'reposChanged',
  'browserProfilesChanged',
  'automationsChanged',
  'agentLaunchPaneVerdict',
  'resolveLegacyWorkerTerminalRecovery',
  'workspaceSleepChanged',
  'terminalFitOverrideChanged',
  'terminalDriverChanged',
  'nativeChatLaunchDraftResolved',
  'browserDriverChanged',
  'browserRemoteViewersChanged',
  'clientHostedBrowserRowsChanged'
])

// Why: these resolve/reject a caller's await; a missing target must reject, never throw synchronously or queue a stale command for later replay.
const asyncRequestMethods: ReadonlySet<string> = new Set<keyof RuntimeNotifier>([
  'revealTerminalSession',
  'publishAgentLaunchTab',
  'revealTerminalPane',
  'closeSessionTab',
  'closeTerminalTab'
])

const tabMethods: ReadonlySet<string> = new Set([
  'splitTerminal',
  'renameTerminal',
  'setPaneTitle',
  'focusTerminal',
  'focusEditorTab',
  'closeSessionTab',
  'closeTerminal',
  'closeTerminalPane',
  'closeTerminalTab'
])

const windowsByRuntime = new WeakMap<OrcaRuntimeService, Map<number, NativeNotifier>>()

const tabRequestArguments = new Map<string, number>([
  ['revealTerminalPane', 0],
  ['revealEditorTab', 0],
  ['revealTerminalSession', 1],
  ['moveSessionTab', 1]
])

function routingTabId(method: string, args: unknown[]): string | null {
  if (tabMethods.has(method)) {
    return typeof args[0] === 'string' ? args[0] : null
  }
  const index = tabRequestArguments.get(method)
  const request = index === undefined ? null : args[index]
  return request &&
    typeof request === 'object' &&
    'tabId' in request &&
    typeof request.tabId === 'string'
    ? request.tabId
    : null
}

function invoke(notifier: RuntimeNotifier, method: string, args: unknown[]): unknown {
  const notify: unknown = Reflect.get(notifier, method)
  return typeof notify === 'function' ? Reflect.apply(notify, notifier, args) : undefined
}

// Why: these report success/failure as a boolean return, mirroring a dropped renderer send
// returning false, rather than resolving a caller's await (asyncRequestMethods) or being void.
const booleanRequestMethods: ReadonlySet<string> = new Set<keyof RuntimeNotifier>(['setPaneTitle'])

/** A method with no eligible target stays silent (or reports failure), matching a dropped renderer send. */
function unavailableResult(method: string): unknown {
  if (asyncRequestMethods.has(method)) {
    return Promise.reject(new Error('runtime_unavailable'))
  }
  return booleanRequestMethods.has(method) ? false : undefined
}

export function registerNativeDesktopNotifier(
  runtime: OrcaRuntimeService,
  window: NativeNotifierWindow,
  notifier: RuntimeNotifier,
  available: () => boolean,
  recover?: () => boolean
): () => void {
  const entries = windowsByRuntime.get(runtime) ?? new Map<number, NativeNotifier>()
  const windowId = window.id
  const entry = { window, notifier, available, recover }
  entries.set(windowId, entry)
  windowsByRuntime.set(runtime, entries)
  const readiness = nativeDesktopNotifierReadiness(runtime)

  const liveEntries = (): NativeNotifier[] =>
    [...entries.values()].filter((item) => !item.window.isDestroyed() && item.available())

  // Reloading windows still need state replay; destroyed windows do not.
  const openEntries = (): NativeNotifier[] =>
    [...entries.values()].filter((item) => !item.window.isDestroyed())

  const readyEntries = (live: NativeNotifier[]): NativeNotifier[] =>
    live.filter((item) => readiness.isReady(item.window.id))

  const publishRouter = (): void => {
    const target = entries.values().next().value?.notifier
    if (!target) {
      runtime.setNotifier(null)
      return
    }
    runtime.setNotifier(
      new Proxy(target, {
        get: (_target, method) => {
          const callback: unknown = Reflect.get(target, method)
          if (typeof callback !== 'function' || typeof method !== 'string') {
            return callback
          }
          return (...args: unknown[]): unknown => {
            if (broadcastMethods.has(method)) {
              for (const item of openEntries()) {
                if (item.available() && readiness.isReady(item.window.id)) {
                  invoke(item.notifier, method, args)
                } else {
                  // Why: a renderer that is mid-reload or whose listeners are not yet proven
                  // mounted must not lose this state notice; queue it and replay once ready.
                  readiness.buffer(item.window.id, method, args)
                }
              }
              return
            }
            const live = liveEntries()
            const ready = readyEntries(live)
            const preferred = preferredDesktopRenderer()
            const tabId = routingTabId(method, args)
            const tabWindows = tabId
              ? nativeDesktopWindowGraphs(runtime).windowIdsForTab(tabId)
              : []
            const candidates = tabWindows.length
              ? ready.filter((item) => tabWindows.includes(item.window.id))
              : ready
            const selected =
              candidates.find((item) => item.window.webContents === preferred) ?? candidates.at(-1)
            if (!selected) {
              // Why: a request/response command must reject (or no-op) rather than block on an
              // unready target or replay a possibly-stale destructive command once one appears.
              return unavailableResult(method)
            }
            return invoke(selected.notifier, method, args)
          }
        }
      })
    )
  }
  publishRouter()
  return () => {
    if (entries.get(windowId) === entry) {
      entries.delete(windowId)
      readiness.forget(windowId)
      publishRouter()
    }
  }
}

function flush(
  runtime: OrcaRuntimeService,
  windowId: number,
  entry: NativeNotifier | undefined,
  pending: readonly { method: string; args: unknown[] }[]
): void {
  // Why: leave it queued rather than lose it if the sender is still unavailable (e.g. a
  // readiness ping can outrace the reload-cancel path settling `available()` back to true);
  // the next ready/restore signal retries delivery.
  if (!entry || entry.window.isDestroyed() || !entry.available()) {
    return
  }
  const readiness = nativeDesktopNotifierReadiness(runtime)
  if (readiness.needsRecovery(windowId)) {
    if (entry.recover?.() === true) {
      readiness.settleRecovery(windowId)
    }
    return
  }
  for (const { method, args } of pending) {
    if (!entry.available() || invoke(entry.notifier, method, args) === false) {
      return
    }
  }
  readiness.settleFlush(windowId, pending)
}

export function flushNativeDesktopNotifier(runtime: OrcaRuntimeService, windowId: number): void {
  const readiness = nativeDesktopNotifierReadiness(runtime)
  if (readiness.isReady(windowId)) {
    flush(
      runtime,
      windowId,
      windowsByRuntime.get(runtime)?.get(windowId),
      readiness.markReady(windowId)
    )
  }
}

/** The renderer proved its runtime listeners are mounted; replay whatever broadcast it missed. */
export function markNativeDesktopNotifierReady(
  runtime: OrcaRuntimeService,
  windowId: number
): void {
  const pending = nativeDesktopNotifierReadiness(runtime).markReady(windowId)
  flush(runtime, windowId, windowsByRuntime.get(runtime)?.get(windowId), pending)
}

/**
 * A provisional reload of this window was cancelled; its listeners never unmounted, so restore
 * its prior readiness and replay anything buffered while the fence was up.
 */
export function restoreNativeDesktopNotifierReady(
  runtime: OrcaRuntimeService,
  windowId: number
): void {
  const pending = nativeDesktopNotifierReadiness(runtime).restoreReady(windowId)
  flush(runtime, windowId, windowsByRuntime.get(runtime)?.get(windowId), pending)
}

/** A reload fence opened for this window; remember its readiness so a cancel can restore it exactly. */
export function beginNativeDesktopNotifierReloadFence(
  runtime: OrcaRuntimeService,
  windowId: number
): void {
  nativeDesktopNotifierReadiness(runtime).beginReloadFence(windowId)
}

/** A new document committed, the process is gone, or the window closed; it must ping again to receive notices. */
export function markNativeDesktopNotifierUnready(
  runtime: OrcaRuntimeService,
  windowId: number
): void {
  nativeDesktopNotifierReadiness(runtime).markUnready(windowId)
}

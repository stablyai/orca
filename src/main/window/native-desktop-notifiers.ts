import type { WebContents } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'
import { nativeDesktopWindowGraphs } from '../runtime/native-desktop-window-graphs'
import { preferredDesktopRenderer } from './desktop-renderer-registry'

type NativeNotifier = {
  window: NativeNotifierWindow
  notifier: RuntimeNotifier
  available: () => boolean
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

export function registerNativeDesktopNotifier(
  runtime: OrcaRuntimeService,
  window: NativeNotifierWindow,
  notifier: RuntimeNotifier,
  available: () => boolean
): () => void {
  const entries = windowsByRuntime.get(runtime) ?? new Map<number, NativeNotifier>()
  const windowId = window.id
  const entry = { window, notifier, available }
  entries.set(windowId, entry)
  windowsByRuntime.set(runtime, entries)

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
            const live = [...entries.values()].filter(
              (item) => !item.window.isDestroyed() && item.available()
            )
            if (broadcastMethods.has(method)) {
              for (const item of live) {
                const notify: unknown = Reflect.get(item.notifier, method)
                if (typeof notify === 'function') {
                  Reflect.apply(notify, item.notifier, args)
                }
              }
              return
            }
            const preferred = preferredDesktopRenderer()
            const tabId = routingTabId(method, args)
            const tabWindows = tabId
              ? nativeDesktopWindowGraphs(runtime).windowIdsForTab(tabId)
              : []
            const candidates = tabWindows.length
              ? live.filter((item) => tabWindows.includes(item.window.id))
              : live
            const selected =
              candidates.find((item) => item.window.webContents === preferred) ?? candidates.at(-1)
            if (!selected) {
              throw new Error('runtime_unavailable')
            }
            const notify: unknown = Reflect.get(selected.notifier, method)
            return typeof notify === 'function'
              ? Reflect.apply(notify, selected.notifier, args)
              : undefined
          }
        }
      })
    )
  }
  publishRouter()
  return () => {
    if (entries.get(windowId) === entry) {
      entries.delete(windowId)
      publishRouter()
    }
  }
}

import { hookMount, performHookAction } from '../hook-mount'
import type { MobileSessionTab } from '../../../session/mobile-session-route-types'
import type { TerminalRecord } from '../../../session/mobile-terminal-records'
import { mountFixture } from '../recorder-fixture-shape'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
const HANDLE = 'terminal-1'

/**
 * Adding and removing session tabs: the markdown note and browser tab a user creates, and the
 * rename/close writes the tab strip makes.
 *
 * Each of these keeps local tab state only on an accepted reply, so the state projection is the tab
 * list itself — a golden that showed the same list after a refusal would be recording the erasure
 * these call sites exist to avoid.
 */
export function sessionScreenTabMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.content-create': ({ client, effect }) => {
      const useCreate = modules.load<
        typeof import('../../../session/use-mobile-session-content-create-actions')
      >(
        'mobile/src/session/use-mobile-session-content-create-actions.ts'
      ).useMobileSessionContentCreateActions
      let creatingBrowser = false
      let creatingMarkdown = false
      let createError = ''
      let screencastSupported = true
      const pendingBrowserFocusPageIdRef: { current: string | null } = { current: null }
      let actions: ReturnType<typeof useCreate>
      const timers: ReturnType<typeof setTimeout>[] = []
      const hook = hookMount(() => {
        actions = useCreate(
          mountFixture<Parameters<typeof useCreate>[0]>({
            worktreeId: WORKSPACE,
            client,
            creatingBrowser,
            setCreatingBrowser: (value) => {
              creatingBrowser = typeof value === 'function' ? value(creatingBrowser) : value
            },
            creatingMarkdown,
            setCreatingMarkdown: (value) => {
              creatingMarkdown = typeof value === 'function' ? value(creatingMarkdown) : value
            },
            setCreateError: (value) => {
              createError = typeof value === 'function' ? value(createError) : value
            },
            pendingBrowserFocusPageIdRef,
            handleCreateBrowserRef: { current: () => Promise.resolve(false) },
            browserScreencastSupportedRef: { current: screencastSupported },
            scheduleDelayedAction: (callback: () => void, delayMs: number) => {
              timers.push(setTimeout(callback, delayMs))
            },
            showToast: (message: string) => effect('toast', { message }),
            fetchSessionTabs: () => {
              effect('fetch-session-tabs', {})
              return Promise.resolve()
            },
            fetchPendingBrowserSessionTabs: () => {
              effect('fetch-pending-browser-tabs', {})
              return Promise.resolve()
            }
          })
        )
      })
      hook.mount()
      return {
        action(name, args) {
          if (name === 'unsupported') {
            screencastSupported = false
            return hook.update()
          }
          return performHookAction(() =>
            name === 'markdown'
              ? actions.handleCreateMarkdownNote()
              : actions.handleCreateBrowser(String(args.url ?? 'https://example.com'))
          )
        },
        state: () => ({
          creatingBrowser,
          creatingMarkdown,
          createError,
          pendingBrowserFocusPageId: pendingBrowserFocusPageIdRef.current
        }),
        dispose: () => {
          for (const timer of timers) {
            clearTimeout(timer)
          }
          hook.unmount()
        }
      }
    },
    'session.tab-close': ({ client, effect }) => {
      const useClose = modules.load<
        typeof import('../../../session/use-mobile-session-close-actions')
      >('mobile/src/session/use-mobile-session-close-actions.ts').useMobileSessionCloseActions
      const terminalTab = mountFixture<Extract<MobileSessionTab, { type: 'terminal' }>>({
        id: 'tab-1',
        type: 'terminal',
        title: 'Terminal',
        terminal: HANDLE,
        isActive: true
      })
      let terminals: TerminalRecord[] = [{ handle: HANDLE, title: 'Terminal', isActive: true }]
      const terminalsRef = { current: terminals }
      const sessionTabsRef = { current: [terminalTab] }
      let sessionTabs: MobileSessionTab[] = sessionTabsRef.current
      let activeHandle: string | null = HANDLE
      const activeHandleRef: { current: string | null } = { current: HANDLE }
      const renameTarget: { handle: string } | null = { handle: HANDLE }
      const timers: ReturnType<typeof setTimeout>[] = []
      let actions: ReturnType<typeof useClose>
      const hook = hookMount(() => {
        actions = useClose(
          mountFixture<Parameters<typeof useClose>[0]>({
            worktreeId: WORKSPACE,
            client,
            terminals,
            terminalsRef,
            setTerminals: (update) => {
              terminals = typeof update === 'function' ? update(terminals) : update
            },
            sessionTabsRef,
            setSessionTabs: (update) => {
              sessionTabs = typeof update === 'function' ? update(sessionTabs) : update
            },
            reconcileBufferedDraftsRef: { current: () => {} },
            closedTabTombstonesRef: { current: new Map() },
            clearTerminalLiveInputDefault: (handle: string) =>
              effect('clear-live-input', { handle }),
            setActiveHandle: (value) => {
              activeHandle = typeof value === 'function' ? value(activeHandle) : value
            },
            setActiveSessionTabId: () => {},
            activeSessionTabIdRef: { current: 'tab-1' },
            selectedSessionTabIdRef: { current: 'tab-1' },
            renameTarget,
            setRenameTarget: () => {},
            terminalRefs: { current: new Map() },
            initializedHandlesRef: { current: new Set([HANDLE]) },
            activeHandleRef,
            activeSessionTabTypeRef: { current: 'terminal' },
            pendingActiveTerminalHandleRef: { current: null },
            pendingBrowserFocusPageIdRef: { current: null },
            scheduleDelayedAction: (callback: () => void, delayMs: number) => {
              timers.push(setTimeout(callback, delayMs))
            },
            unsubscribeTerminal: (handle: string) => effect('unsubscribe-terminal', { handle }),
            subscribeToTerminal: (handle: string) => effect('subscribe-terminal', { handle }),
            fetchTerminals: () => {
              effect('fetch-terminals', {})
              return Promise.resolve(true)
            }
          })
        )
      })
      hook.mount()
      return {
        action(name, args) {
          if (name === 'rename') {
            return performHookAction(() =>
              actions.handleRenameTerminal(String(args.title ?? 'renamed'))
            )
          }
          if (name === 'close-terminal') {
            return performHookAction(() =>
              actions.handleCloseTerminal({ handle: HANDLE, title: 'Terminal', isActive: true })
            )
          }
          if (name === 'close-tab') {
            return performHookAction(() => actions.handleCloseSessionTab(terminalTab))
          }
          throw new Error(`Unknown tab close action: ${name}`)
        },
        state: () => ({ terminals, sessionTabs, activeHandle }),
        dispose: () => {
          for (const timer of timers) {
            clearTimeout(timer)
          }
          hook.unmount()
        }
      }
    }
  }
}

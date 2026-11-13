import type * as UseMobileSessionTerminalCreateActionsModule from '../../../terminal/session/creation/use-mobile-session-terminal-create-actions'
import type { PendingSessionSelection } from '../../../session/tabs/pending-session-selection'
import { hookMount } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type {
  MobileSessionTab,
  MobileSessionTabType
} from '../../../session/tabs/mobile-session-tabs'
import type { TerminalRecord as Terminal } from '../../../terminal/session/inventory/mobile-terminal-records'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../src/shared/protocol-version'

const PREVIOUS_HANDLE = 'terminal-0'

// Record unsubscribe choice to catch leaked desktop dimensions; no device subscription runs here.
// Scenario inputs own wire values and omissions: worktree/tab on mount, launch options on create.
// The scheduler pins time/randomness and primes React so mutation ids stay deterministic.
export function sessionTerminalCreateMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.create-terminal': ({ client, effect }) => {
      const useCreateActions = modules.load<typeof UseMobileSessionTerminalCreateActionsModule>(
        'mobile/src/terminal/session/creation/use-mobile-session-terminal-create-actions.ts'
      ).useMobileSessionTerminalCreateActions
      modules.load('mobile/src/terminal/session/creation/mobile-session-terminal-create-request.ts')

      let terminals: Terminal[] = []
      let sessionTabs: MobileSessionTab[] = []
      let activeHandle: string | null = PREVIOUS_HANDLE
      let worktreeId = ''
      let activeSessionTabId: string | null = null
      const hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
      let creating = false
      let createError = ''
      const terminalsRef = { current: terminals }
      const activeHandleRef = { current: activeHandle }
      const activeSessionTabIdRef: { current: string | null } = { current: null }
      const activeSessionTabTypeRef: { current: MobileSessionTabType | null } = {
        current: 'terminal'
      }
      const pendingSelectionRef: { current: PendingSessionSelection | null } = { current: null }
      const creatingTerminalRef: { current: string | null } = { current: null }
      const initializedHandlesRef = { current: new Set([PREVIOUS_HANDLE]) }
      const deviceTokenRef: { current: string | null } = { current: null }
      const delayedActionTimers = new Set<ReturnType<typeof setTimeout>>()

      let actions: ReturnType<typeof useCreateActions> | undefined
      const hook = hookMount(() => {
        actions = useCreateActions(
          mountFixture<Parameters<typeof useCreateActions>[0]>({
            worktreeId,
            client,
            hostCapabilities,
            connState: 'connected',
            setTerminals: (update) => {
              terminals = typeof update === 'function' ? update(terminals) : update
            },
            terminalsRef,
            setSessionTabs: (update) => {
              sessionTabs = typeof update === 'function' ? update(sessionTabs) : update
            },
            setActiveHandle: (update) => {
              activeHandle = typeof update === 'function' ? update(activeHandle) : update
            },
            activeSessionTabId,
            activeSessionTabIdRef,
            setActiveSessionTabId: (update) => {
              activeSessionTabId =
                typeof update === 'function' ? update(activeSessionTabId) : update
            },
            setCreating: (update) => {
              creating = typeof update === 'function' ? update(creating) : update
            },
            creatingTerminalRef,
            creatingBrowser: false,
            creatingMarkdown: false,
            setCreateError: (update) => {
              createError = typeof update === 'function' ? update(createError) : update
            },
            deviceTokenRef,
            initializedHandlesRef,
            activeHandleRef,
            activeSessionTabTypeRef,
            pendingSelectionRef,
            scheduleDelayedAction: (fn: () => void, ms: number) => {
              effect('schedule-delayed-action', { delayMs: ms })
              delayedActionTimers.add(setTimeout(fn, ms))
            },
            showToast: (message: string, durationMs?: number) =>
              effect('toast', { message, durationMs: durationMs ?? null }),
            unsubscribeTerminal: (handle: string) => {
              initializedHandlesRef.current.delete(handle)
              effect('unsubscribe-terminal', { handle })
            },
            subscribeToTerminal: (handle: string) => {
              effect('subscribe-terminal', { handle })
              return true
            },
            fetchSessionTabs: async () => {
              effect('fetch-session-tabs', {})
            }
          })
        )
      })

      return {
        action(name, args) {
          if (name === 'mount') {
            worktreeId = String(args.worktreeId)
            activeSessionTabId =
              typeof args.activeSessionTabId === 'string' ? args.activeSessionTabId : null
            activeSessionTabIdRef.current = activeSessionTabId
            deviceTokenRef.current = typeof args.deviceToken === 'string' ? args.deviceToken : null
            return hook.mount()
          }
          if (name !== 'create') {
            throw new Error(`Unknown terminal create action: ${name}`)
          }
          const options = {
            ...(args.initialPrompt === undefined
              ? {}
              : { initialPrompt: String(args.initialPrompt) }),
            ...(args.successToast === undefined ? {} : { successToast: String(args.successToast) }),
            ...(args.errorToast === undefined ? {} : { errorToast: String(args.errorToast) })
          }
          return actions!.handleCreateTerminal(
            undefined,
            Object.keys(options).length === 0 ? undefined : options
          )
        },
        state: () => ({
          activeHandle,
          activeSessionTabId,
          creating,
          createError,
          terminals: terminals.map((terminal) => terminal.handle),
          sessionTabs: sessionTabs.map((tab) => tab.id),
          pendingSelection: pendingSelectionRef.current,
          initializedHandles: [...initializedHandlesRef.current].sort()
        }),
        dispose() {
          const errors: unknown[] = []
          try {
            hook.unmount()
          } catch (error) {
            errors.push(error)
          }
          for (const timer of delayedActionTimers) {
            try {
              clearTimeout(timer)
            } catch (error) {
              errors.push(error)
            }
          }
          delayedActionTimers.clear()
          if (errors.length === 1) {
            throw errors[0]
          }
          if (errors.length) {
            throw new AggregateError(errors, 'Terminal fixture cleanup failed')
          }
        }
      }
    }
  }
}

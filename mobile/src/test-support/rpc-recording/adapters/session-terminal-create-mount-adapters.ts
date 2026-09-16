import { hookMount } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type {
  MobileSessionTab,
  MobileSessionTabType,
  Terminal
} from '../../../session/mobile-session-route-types'

const PREVIOUS_HANDLE = 'terminal-0'
const WORKTREE_ID = 'wt-1'
const ACTIVE_TAB_ID = 'tab-0'

/**
 * The New Tab terminal create, and the optional prompt it drops into the terminal it made.
 *
 * No WebView ref reaches this hook either: `subscribeToTerminal` and `unsubscribeTerminal` are scope
 * callbacks, so they record as effects and the create path runs end to end without a device. The
 * unsubscribe is the one worth naming — replacing an active handle has to release the old stream or
 * the host never restores its desktop dimensions — and an effect is exactly the observation that the
 * hook chose it.
 *
 * `clientMutationId` mixes `Date.now()` and `Math.random()`, both pinned by the `Math.random` spy
 * `start()` installs in `vitest-recording-scheduler.ts` — but pinning the sequence is not the whole of determinism here,
 * which is why the mount happens in the factory rather than as a scripted step. React draws one
 * `Math.random()` of its own before it ever schedules: `enqueueTask` in `react.development.js`
 * evaluates `("require" + Math.random()).slice(0, 7)` to hide its `require` call from bundlers, once
 * per process and lazily, on the first task it enqueues. `runRecording` flushes through `await act`
 * after every step, so a scripted mount would put that flush — and therefore React's draw — before
 * the create. The create's own draw would then be the second of the seeded sequence on the first
 * recording in a process and the first on every later one, and the two determinism runs would
 * disagree on the recorded key: `Request params mismatch: session.tabs.createTerminal#1`, on
 * `clientMutationId` alone. Mounting in the factory keeps the create ahead of any flush, so its draw
 * is the first of the sequence whether React is warm or cold.
 *
 * That is a workaround for an engine defect, not a property of this family. #21088 pays React's
 * lazy draw when the seed is installed, which makes the position of the mount irrelevant; once it
 * lands this mount moves back to a scripted step and no golden moves with it.
 *
 * State is the tab and terminal lists the hook publishes, the active handle and tab, and the create
 * error, because those are what a refused or unreadable create leaves on the screen.
 */
export function sessionTerminalCreateMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.create-terminal': ({ client, effect }) => {
      const useCreateActions = modules.load<
        typeof import('../../../session/use-mobile-session-terminal-create-actions')
      >(
        'mobile/src/session/use-mobile-session-terminal-create-actions.ts'
      ).useMobileSessionTerminalCreateActions

      let terminals: Terminal[] = []
      let sessionTabs: MobileSessionTab[] = []
      let activeHandle: string | null = PREVIOUS_HANDLE
      let activeSessionTabId: string | null = ACTIVE_TAB_ID
      let creating = false
      let createError = ''
      const terminalsRef = { current: terminals }
      const activeHandleRef = { current: activeHandle }
      const activeSessionTabIdRef = { current: activeSessionTabId }
      const activeSessionTabTypeRef: { current: MobileSessionTabType | null } = {
        current: 'terminal'
      }
      const pendingActiveSessionTabIdRef: { current: string | null } = { current: null }
      const pendingActiveTerminalHandleRef: { current: string | null } = { current: null }
      const creatingTerminalRef = { current: false }
      const initializedHandlesRef = { current: new Set([PREVIOUS_HANDLE]) }
      const deviceTokenRef: { current: string | null } = { current: null }

      let actions: ReturnType<typeof useCreateActions> | undefined
      const hook = hookMount(() => {
        actions = useCreateActions(
          mountFixture<Parameters<typeof useCreateActions>[0]>({
            worktreeId: WORKTREE_ID,
            client,
            connState: 'connected',
            setTerminals: (update) => {
              terminals = typeof update === 'function' ? update(terminals) : update
            },
            terminalsRef,
            setSessionTabs: (update) => {
              sessionTabs = typeof update === 'function' ? update(sessionTabs) : update
            },
            defaultTerminalHandlesToLiveInput: (handles: readonly string[]) =>
              effect('default-live-input', { handles: [...handles] }),
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
            pendingActiveSessionTabIdRef,
            pendingActiveTerminalHandleRef,
            scheduleDelayedAction: (fn: () => void, ms: number) => {
              effect('schedule-delayed-action', { delayMs: ms })
              setTimeout(fn, ms)
            },
            showToast: (message: string, durationMs?: number) =>
              effect('toast', { message, durationMs: durationMs ?? null }),
            unsubscribeTerminal: (handle: string) => effect('unsubscribe-terminal', { handle }),
            subscribeToTerminal: (handle: string) => effect('subscribe-terminal', { handle }),
            fetchSessionTabs: async () => {
              effect('fetch-session-tabs', {})
            }
          })
        )
      })

      hook.mount()

      return {
        action(name, args) {
          if (name === 'create') {
            // Declared by the scenario, never by this stub: the prompt send carries it as a param.
            deviceTokenRef.current = typeof args.deviceToken === 'string' ? args.deviceToken : null
            const prompt = args.initialPrompt
            return actions!.handleCreateTerminal(
              undefined,
              prompt === undefined
                ? undefined
                : {
                    initialPrompt: String(prompt),
                    successToast:
                      args.successToast === undefined ? undefined : String(args.successToast),
                    errorToast: args.errorToast === undefined ? undefined : String(args.errorToast)
                  }
            )
          }
          throw new Error(`Unknown terminal create action: ${name}`)
        },
        state: () => ({
          activeHandle,
          activeSessionTabId,
          creating,
          createError,
          terminals: terminals.map((terminal) => terminal.handle),
          sessionTabs: sessionTabs.map((tab) => tab.id),
          pendingActiveTerminalHandle: pendingActiveTerminalHandleRef.current,
          pendingActiveSessionTabId: pendingActiveSessionTabIdRef.current,
          initializedHandles: [...initializedHandlesRef.current].sort()
        }),
        dispose: hook.unmount
      }
    }
  }
}

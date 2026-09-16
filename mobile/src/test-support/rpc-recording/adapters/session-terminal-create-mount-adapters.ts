import { hookMount } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type {
  MobileSessionTab,
  MobileSessionTabType,
  Terminal
} from '../../../session/mobile-session-route-types'
import type { TuiAgent } from '../../../../../src/shared/tui-agent'

const PREVIOUS_HANDLE = 'terminal-0'

/**
 * The agents a scenario may name. `satisfies` keeps the list a subset of the real union, so a
 * scenario naming an agent the product does not have fails here instead of reaching the wire as an
 * unchecked string.
 */
const DECLARABLE_AGENTS = ['claude', 'codex'] as const satisfies readonly TuiAgent[]

function declaredAgent(value: unknown): TuiAgent | undefined {
  if (value === undefined) {
    return undefined
  }
  const agent = DECLARABLE_AGENTS.find((candidate) => candidate === value)
  if (!agent) {
    throw new Error(`Unknown agent: ${String(value)}`)
  }
  return agent
}

/**
 * The New Tab terminal create, and the optional prompt it drops into the terminal it made.
 *
 * No WebView ref reaches this hook either: `subscribeToTerminal` and `unsubscribeTerminal` are scope
 * callbacks, so they record as effects and the create path runs end to end without a device. The
 * unsubscribe is the one worth naming — replacing an active handle has to release the old stream or
 * the host never restores its desktop dimensions — and an effect is exactly the observation that the
 * hook chose it.
 *
 * Every member this family puts on the wire comes from the scenario: the worktree, the tab the new
 * one is inserted after, the four launch options a quick command fills, and the device token the
 * prompt send carries. An argument the scenario leaves out is a cell the hook sees empty, which is
 * what lets a golden hold an omission — `afterTabId` is absent on a fresh session and after the
 * last tab closes, and no adapter constant may decide that.
 *
 * The worktree and the active tab are read as the hook renders, so the scenario declares them on
 * the `mount` step rather than on the create that sends them; the launch options are call
 * arguments and are declared where they are passed.
 *
 * `clientMutationId` mixes `Date.now()` and `Math.random()`, both pinned by `start()` in
 * `vitest-recording-scheduler.ts`, which also pays React's one lazy `Math.random()` draw before it
 * installs the seed, so this create reads the same seeded value cold or warm.
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
      let worktreeId = ''
      let activeSessionTabId: string | null = null
      let creating = false
      let createError = ''
      const terminalsRef = { current: terminals }
      const activeHandleRef = { current: activeHandle }
      const activeSessionTabIdRef: { current: string | null } = { current: null }
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
            worktreeId,
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

      return {
        action(name, args) {
          if (name === 'mount') {
            // Declared by the scenario, never by this stub, because each of these reaches the wire.
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
          const agent = declaredAgent(args.agent)
          if (
            args.startupCommandDelivery !== undefined &&
            args.startupCommandDelivery !== 'shell-ready'
          ) {
            throw new Error(`Unknown startup delivery: ${String(args.startupCommandDelivery)}`)
          }
          // A launch the scenario left empty is no launch at all: the bare New Tab create passes no
          // options, and that is the arm the structured-provider branch reads.
          const options = {
            ...(args.initialPrompt === undefined
              ? {}
              : { initialPrompt: String(args.initialPrompt) }),
            ...(args.successToast === undefined ? {} : { successToast: String(args.successToast) }),
            ...(args.errorToast === undefined ? {} : { errorToast: String(args.errorToast) }),
            ...(args.startupCommand === undefined
              ? {}
              : { startupCommand: String(args.startupCommand) }),
            ...(args.startupCommandDelivery === undefined
              ? {}
              : { startupCommandDelivery: 'shell-ready' as const }),
            ...(args.agentPrompt === undefined ? {} : { agentPrompt: String(args.agentPrompt) })
          }
          return actions!.handleCreateTerminal(
            agent,
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
          pendingActiveTerminalHandle: pendingActiveTerminalHandleRef.current,
          pendingActiveSessionTabId: pendingActiveSessionTabIdRef.current,
          initializedHandles: [...initializedHandlesRef.current].sort()
        }),
        dispose: hook.unmount
      }
    }
  }
}

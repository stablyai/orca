import type { PendingSessionSelection } from '../../../session/pending-session-selection'
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
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../src/shared/protocol-version'

const PREVIOUS_HANDLE = 'terminal-0'

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

// Record unsubscribe choice to catch leaked desktop dimensions; no device subscription runs here.
// Scenario inputs own wire values and omissions: worktree/tab on mount, launch options on create.
// The scheduler pins time/randomness and primes React so mutation ids stay deterministic.
const AGENT_LAUNCH_HOST_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]

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
      modules.load('mobile/src/session/mobile-session-terminal-create-request.ts')

      let terminals: Terminal[] = []
      let sessionTabs: MobileSessionTab[] = []
      let activeHandle: string | null = PREVIOUS_HANDLE
      let worktreeId = ''
      let activeSessionTabId: string | null = null
      let hostCapabilities: string[] = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
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
            pendingSelectionRef,
            scheduleDelayedAction: (fn: () => void, ms: number) => {
              effect('schedule-delayed-action', { delayMs: ms })
              setTimeout(fn, ms)
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
            hostCapabilities = [
              ...(args.supportsSplitGroupPlacement === false
                ? []
                : [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]),
              ...(args.agentLaunch === true ? AGENT_LAUNCH_HOST_CAPABILITIES : [])
            ]
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
          // Preserve omitted launch options so bare New Tab reaches the structured-provider branch.
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
          pendingSelection: pendingSelectionRef.current,
          initializedHandles: [...initializedHandlesRef.current].sort()
        }),
        dispose: hook.unmount
      }
    }
  }
}

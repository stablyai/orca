import { hookScreenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { MobileDisplayMode } from '../../../session/mobile-session-route-types'

const HANDLE = 'terminal-1'

// Scenario-declared viewport/token cells start empty to cover sends before measurement or token assignment.
// Record native-chat reconciliation choices as effects; the in-flight set is the toggle’s only local state.
export function sessionTerminalDisplayModeMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.terminal-display-mode': ({ client, effect }) => {
      const useStreamDisplay = modules.load<
        typeof import('../../../session/use-mobile-session-terminal-stream-display')
      >(
        'mobile/src/session/use-mobile-session-terminal-stream-display.ts'
      ).useMobileSessionTerminalStreamDisplay

      const terminalModes = new Map<string, MobileDisplayMode>()
      const viewportRef: { current: { cols: number; rows: number } | null } = { current: null }
      const deviceTokenRef: { current: string | null } = { current: null }
      let display: ReturnType<typeof useStreamDisplay> | undefined
      const screen = hookScreenMount(() => {
        display = useStreamDisplay(
          mountFixture<Parameters<typeof useStreamDisplay>[0]>({
            client,
            activeHandle: HANDLE,
            coveredStreamRevision: 0,
            terminalModes,
            deviceTokenRef,
            viewportRef,
            terminalUnsubsRef: { current: new Map() },
            subscribingHandlesRef: { current: new Set() },
            leaseOnlyHandlesRef: { current: new Set() },
            initializedHandlesRef: { current: new Set() },
            webReadyHandlesRef: { current: new Set([HANDLE]) },
            activeSessionTab: { id: 'tab-1', type: 'terminal' },
            nativeChatInputLeaseReady: false,
            showNativeChat: false,
            unsubscribeTerminal: (handle: string) => effect('unsubscribe-terminal', { handle }),
            subscribeToTerminal: (handle: string) => effect('subscribe-terminal', { handle })
          })
        )
      }, effect)

      return {
        action(name, args) {
          if (name === 'mount') {
            deviceTokenRef.current = typeof args.deviceToken === 'string' ? args.deviceToken : null
            const viewport = args.viewport
            if (viewport !== undefined) {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario declares this argument as the `{cols, rows}` pair the hook forwards.
              viewportRef.current = viewport as { cols: number; rows: number } | null
            }
            for (const [handle, mode] of Object.entries(args.modes ?? {})) {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario declares the stored mode the toggle reads.
              terminalModes.set(handle, mode as MobileDisplayMode)
            }
            return screen.mount()
          }
          if (name === 'toggle') {
            return display!.toggleDisplayMode(String(args.handle ?? HANDLE))
          }
          throw new Error(`Unknown terminal display-mode action: ${name}`)
        },
        state: () => ({
          inFlight: [...(display?.toggleInFlightRef.current ?? [])].sort(),
          viewport: viewportRef.current,
          crash: screen.crash()
        }),
        dispose: screen.unmount
      }
    }
  }
}

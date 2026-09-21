import { hookScreenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { MobileDisplayMode } from '../../../session/mobile-session-route-types'

const HANDLE = 'terminal-1'

/**
 * The terminal menu's display-mode toggle.
 *
 * No WebView ref reaches this hook. It reads a `{cols, rows}` cell some other surface measured and
 * a device-token cell, and both ride `terminal.setDisplayMode`; the send is gated on `client` and
 * the hook's own in-flight set, not on an open subscription. So the mount needs no terminal handle
 * and no substitute for one — the viewport pair, the device token and the stored modes are
 * scenario-declared values, visible in the golden as the params they become.
 *
 * Both cells start empty and an undeclared cell stays empty, because each one is a member the send
 * only carries when it is filled: a scenario that declares neither records the shape a phone sends
 * before it has measured itself or been given a token, which is the arm those two guards exist for.
 *
 * The native-chat stream reconciliation the same hook owns runs on mount and its subscribe and
 * unsubscribe are recorded as effects, for the reason `terminal.viewport-refit` records its own:
 * what is observable is which one the hook chose, not what subscribing does to a device.
 *
 * State is the in-flight set, because that is the whole of what the toggle keeps: the reply body is
 * never read, the server owns the resulting mode, and a second toggle of a handle already in flight
 * is the one decision the set makes.
 */
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
            // Declared by the scenario, never by this stub: both are recorded params.
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

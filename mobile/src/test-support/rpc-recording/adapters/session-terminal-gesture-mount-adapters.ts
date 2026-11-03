import { hookScreenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { TerminalModes } from '../../../terminal/terminal-webview-contract'
import type {
  Terminal,
  TerminalGestureInputBucket,
  TerminalGestureInputQueue
} from '../../../session/mobile-session-route-types'

const HANDLE = 'terminal-1'
const DEVICE_TOKEN = 'device-token-1'
const WHEEL_REPORT = '[<64;10;5M'
const PTY_MODES: TerminalModes = {
  bracketedPasteMode: false,
  altScreen: false,
  mouseTrackingMode: 'any',
  sgrMouseMode: true,
  sgrMousePixelsMode: false,
  applicationCursorKeysMode: false,
  kittyKeyboardFlags: 0,
  modifyOtherKeys: 0
}

// Record send/clear outcomes and queue accounting without a WebView; local clear rendering is outside this oracle.
export function sessionTerminalGestureMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.terminal-gesture-input': ({ client, effect }) => {
      const useTerminalInput = modules.load<
        typeof import('../../../session/use-mobile-session-terminal-input')
      >('mobile/src/session/use-mobile-session-terminal-input.ts').useMobileSessionTerminalInput

      const buckets = { current: new Map<string, TerminalGestureInputBucket>() }
      const queues = { current: new Map<string, TerminalGestureInputQueue>() }
      const inFlight = { current: new Set<string>() }
      let input: ReturnType<typeof useTerminalInput> | undefined
      const screen = hookScreenMount(() => {
        input = useTerminalInput(
          mountFixture<Parameters<typeof useTerminalInput>[0]>({
            client,
            connState: 'connected',
            activeHandle: HANDLE,
            clientRef: { current: client },
            connStateRef: { current: 'connected' },
            deviceTokenRef: { current: DEVICE_TOKEN },
            activeHandleRef: { current: HANDLE },
            activeSessionTabTypeRef: { current: 'terminal' },
            ptyModesRef: { current: new Map([[HANDLE, PTY_MODES]]) },
            terminalGestureInputBucketsRef: buckets,
            terminalGestureInputQueuesRef: queues,
            terminalGestureInputInFlightRef: inFlight,
            liveInputRef: { current: null },
            liveInputFocusTimerRef: { current: null },
            terminalUnsubsRef: { current: new Map([[HANDLE, () => {}]]) },
            hostQueryReplyInputSupportedRef: { current: false },
            hostProgramStatusSupportedRef: { current: false },
            clearPendingLiveInputCommit: () => {},
            toggleTerminalLiveInput: () => false,
            getTerminalRef: () => undefined,
            unsubscribeTerminal: (handle) => effect('terminal-unsubscribe', { handle }),
            subscribeToTerminal: (handle) => {
              effect('terminal-subscribe', { handle })
              return true
            },
            showToast: (message: string, durationMs?: number) =>
              effect('toast', { message, durationMs: durationMs ?? null })
          })
        )
      }, effect)

      return {
        action(name, args) {
          if (name === 'mount') {
            return screen.mount()
          }
          if (name === 'gesture') {
            return input!.handleTerminalInput(HANDLE, String(args.bytes ?? WHEEL_REPORT))
          }
          if (name === 'clear') {
            const target: Terminal = { handle: HANDLE, title: 'zsh', isActive: true }
            return input!.handleClearTerminal(target)
          }
          throw new Error(`Unknown terminal gesture action: ${name}`)
        },
        state: () => ({
          queuedSequences: queues.current.get(HANDLE)?.sequenceCount ?? null,
          queuedBytes: queues.current.get(HANDLE)?.bytes ?? null,
          inFlight: inFlight.current.has(HANDLE),
          bucketTokens: buckets.current.get(HANDLE)?.tokens ?? null,
          crash: screen.crash()
        }),
        dispose: () => screen.unmount()
      }
    }
  }
}

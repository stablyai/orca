import type { MountAdapter, MountContext } from '../recording-scenario'
import { hookMount } from '../hook-mount'
import type { operationModuleLoader } from '../operation-module-loader'

const HANDLE = 'terminal-1'
const DEVICE_TOKEN = 'device-token-1'
const VIEWPORT = { cols: 100, rows: 30 }

/** The xterm handle the refit hook drives; `reflow` is an observation, not a native call. */
function terminalWebViewHandle(
  effect: MountContext['effect'],
  dims: { cols: number; rows: number }
) {
  return {
    measureFitDimensions: (frameHeight?: number) => {
      effect('measure-fit', { frameHeight: frameHeight ?? null })
      return Promise.resolve(dims)
    },
    reflow: (cols: number, rows: number) => effect('reflow', { cols, rows })
  }
}

/**
 * Terminal input, the worker-takeover report it triggers, and the in-place viewport refit.
 *
 * Every send here is a request/response call; the `subscribe` and `sendUnsubscribe` ports these
 * files sit next to are a separate boundary and are not driven. The refit hook's resubscribe
 * fallback is recorded as an effect for the same reason — what the recording observes is that the
 * hook chose it, not what resubscribing does.
 */
export function terminalMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'terminal.query-reply': ({ client }) => {
      const send = modules.load<typeof import('../../../terminal/mobile-terminal-query-reply')>(
        'mobile/src/terminal/mobile-terminal-query-reply.ts'
      ).sendMobileTerminalQueryReply
      const subscribed = new Set([HANDLE])
      let accepted: unknown = 'unsent'
      return {
        action: (_name, args) =>
          send({
            bytes: String(args.bytes ?? '[0n'),
            client,
            clientId: args.clientId === null ? null : String(args.clientId ?? DEVICE_TOKEN),
            connected: args.connected !== false,
            handle: String(args.handle ?? HANDLE),
            hostSupportsQueryReplyInput: args.supported !== false,
            subscribedTerminals: { has: (handle: string) => subscribed.has(handle) }
          }).then((value: unknown) => {
            accepted = value
            return value
          }),
        state: () => ({ accepted }),
        dispose: () => {}
      }
    },
    'terminal.accessory-raw-send': ({ client }) => {
      const send = modules.load<
        typeof import('../../../terminal/terminal-live-accessory-raw-send')
      >('mobile/src/terminal/terminal-live-accessory-raw-send.ts').sendTerminalLiveAccessoryRawBytes
      let accepted: unknown = 'unsent'
      return {
        action: (_name, args) =>
          send({
            client,
            targetHandle: HANDLE,
            activeHandle: args.activeHandle === null ? null : String(args.activeHandle ?? HANDLE),
            activeSessionTabType: String(args.tabType ?? 'terminal'),
            connState: args.connected === false ? 'disconnected' : 'connected',
            bytes: String(args.bytes ?? 'ls'),
            deviceToken: args.deviceToken === null ? null : String(args.deviceToken ?? DEVICE_TOKEN)
          }).then((value: unknown) => {
            accepted = value
            return value
          }),
        state: () => ({ accepted }),
        dispose: () => {}
      }
    },
    'terminal.takeover-report': ({ client }) => {
      const report = modules.load<
        typeof import('../../../terminal/worker-terminal-takeover-report')
      >('mobile/src/terminal/worker-terminal-takeover-report.ts')
      // The per-client report window is module state; a fresh recording must not inherit one.
      report.resetWorkerTerminalTakeoverReportsForTest()
      return {
        action: (_name, args) =>
          report.reportWorkerTerminalUserInput(client, String(args.terminal ?? HANDLE)),
        state: () => ({}),
        dispose: report.resetWorkerTerminalTakeoverReportsForTest
      }
    },
    'terminal.viewport-refit': ({ client, effect }) => {
      const useRefit = modules.load<typeof import('../../../terminal/terminal-viewport-refit')>(
        'mobile/src/terminal/terminal-viewport-refit.ts'
      ).useTerminalViewportRefit
      const terminalRefs = { current: new Map([[HANDLE, terminalWebViewHandle(effect, VIEWPORT)]]) }
      const viewportRef: { current: { cols: number; rows: number } | null } = { current: null }
      const viewportMeasuredRef = { current: false }
      const connState = 'connected'
      let notifications: ReturnType<typeof useRefit>
      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the refs and callbacks the hook reads.
        notifications = useRefit({
          activeHandleRef: { current: HANDLE },
          terminalRefs,
          terminalFrameHeightRef: { current: 600 },
          viewportRef,
          viewportMeasuredRef,
          nativeChatCoveredRef: { current: false },
          clientRef: { current: client },
          deviceTokenRef: { current: DEVICE_TOKEN },
          initializedHandlesRef: { current: new Set([HANDLE]) },
          connState,
          tabStripVisible: true,
          textScale: 1,
          terminalFrameWidth: 390,
          unsubscribeTerminal: (handle: string) => effect('unsubscribe-terminal', { handle }),
          subscribeToTerminal: (handle: string) => effect('subscribe-terminal', { handle })
        } as unknown as Parameters<typeof useRefit>[0])
      })
      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'height') {
            return notifications.notifyTerminalFrameHeight(Number(args.height ?? 640))
          }
          throw new Error(`Unknown terminal viewport action: ${name}`)
        },
        state: () => ({ viewport: viewportRef.current, measured: viewportMeasuredRef.current }),
        dispose: hook.unmount
      }
    }
  }
}

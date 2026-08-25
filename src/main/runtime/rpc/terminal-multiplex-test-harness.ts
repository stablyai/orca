import { vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'

export const SET_OUTPUT_PAUSED_OPCODE = 16 as TerminalStreamOpcode
export const WRITE_UNAVAILABLE_OPCODE = 17 as TerminalStreamOpcode

export function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  const serializeAuthoritativeTerminalBuffer =
    overrides.serializeAuthoritativeTerminalBuffer ??
    ((ptyId: string, opts?: { scrollbackRows?: number }) =>
      overrides.serializeTerminalBuffer?.(ptyId, opts))
  return {
    getRuntimeId: () => 'test-runtime',
    // Why: every multiplex stream registers as a remote view subscriber for
    // Phase-5 query-authority suppression (terminal-query-authority.md).
    registerRemoteTerminalViewSubscriber: () => () => {},
    // Why: the multiplex subscribe path resolves handles via
    // resolveLiveLeafForHandle (#7718). Default to a live pty so tests that
    // only stub the legacy resolveLeafForHandle still bind; tests that need a
    // null/stale leaf override this explicitly.
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    serializeAuthoritativeTerminalBuffer,
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    ...overrides
  } as OrcaRuntimeService
}

export function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

export function startDesktopMultiplexSubscribe(
  overrides: Partial<OrcaRuntimeService> = {},
  trace?: string[],
  sendBinaryOverride?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
) {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const registry = createSubscriptionRegistryDouble()
  const runtime = stubRuntime({
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    cleanupSubscriptionIfOwnedByConnection: vi.fn(registry.cleanupSubscriptionIfOwnedByConnection),
    cleanupSubscriptionsForConnection: vi.fn(registry.cleanupSubscriptionsForConnection),
    ...overrides,
    waitForTerminal:
      overrides.waitForTerminal ?? vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (msg) => {
      messages.push(msg)
      const type = JSON.parse(msg).result?.type
      if (type) {
        trace?.push(type)
      }
    },
    {
      connectionId: 'conn-desktop-first-paint',
      sendBinary: (bytes) => {
        const sent = sendBinaryOverride?.(bytes)
        if (sent === false) {
          return false
        }
        binaryFrames.push(bytes)
        const opcode = decodeTerminalStreamFrame(bytes)?.opcode
        if (
          opcode === TerminalStreamOpcode.SnapshotStart ||
          opcode === TerminalStreamOpcode.SnapshotChunk ||
          opcode === TerminalStreamOpcode.SnapshotEnd
        ) {
          trace?.push('snapshot')
        }
        return sent
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => {
          if (handlers.get(streamId) === handler) {
            handlers.delete(streamId)
          }
        }
      }
    }
  )
  return { messages, binaryFrames, handlers, registry, runtime, dispatchPromise }
}

export function sendDesktopMultiplexSubscribe(
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>,
  capabilities: Record<string, 1> = { ackOutput: 1, desktopViewportClaims: 1 }
) {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 7,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities,
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
}

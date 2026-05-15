/* oxlint-disable max-lines -- Why: terminal RPC methods are co-located for discoverability; splitting would scatter related handlers across files. */
import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import type { DriverState, OrcaRuntimeService } from '../../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'

// Why: when a mobile client subscribes the server resizes the PTY to phone
// dims and serializes the buffer. Sending only the visible screen meant
// users coming back to the app or switching terminals could no longer scroll
// up to see prior agent output. Include enough scrollback to keep typical
// agent runs (Claude Code chats, command output) reachable. The mobile
// WebView's xterm has a 5000-row buffer so this fits comfortably.
const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000
const MOBILE_SNAPSHOT_BYTE_BUDGET = 512 * 1024
const TERMINAL_STREAM_CHUNK_BYTES = 48 * 1024
const TERMINAL_OUTPUT_FLUSH_MS = 5
const TERMINAL_OUTPUT_BATCH_MAX_CHARS = 64 * 1024
const TERMINAL_MULTIPLEX_PENDING_MAX_CHARS = 256 * 1024
let nextTerminalStreamId = 1

type SnapshotFrameOptions = {
  kind: 'scrollback' | 'resized'
  cols: number
  rows: number
  data: string
  displayMode?: string
  reason?: string
  seq?: number
  truncated?: boolean
  truncatedByByteBudget?: boolean
}

type SerializedSnapshot = {
  data: string
  cols: number
  rows: number
  scrollbackRows: number
  truncatedByByteBudget: boolean
} | null

type TerminalViewportClient = {
  id: string
  type?: 'mobile' | 'desktop'
}

type TerminalMultiplexStream = {
  streamId: number
  terminal: string
  ptyId: string
  client: TerminalViewportClient | undefined
  isMobile: boolean
  buffering: boolean
  pendingOutput: string[]
  pendingOutputChars: number
  outputBatcher: ReturnType<typeof createTerminalOutputBatcher>
  unsubscribeData: () => void
  unsubscribeResize: () => void
  unsubscribeFit: () => void
  unsubscribeDriver: () => void
  unregisterBinaryHandler: () => void
}

function createTerminalOutputBatcher(onFlush: (data: string) => void): {
  push: (data: string) => void
  flush: () => void
  dispose: () => void
} {
  let chunks: string[] = []
  let chars = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    clearTimer()
    if (chunks.length === 0) {
      return
    }
    const data = chunks.length === 1 ? chunks[0]! : chunks.join('')
    chunks = []
    chars = 0
    onFlush(data)
  }

  return {
    push(data: string): void {
      if (!data) {
        return
      }
      chunks.push(data)
      chars += data.length
      if (chars >= TERMINAL_OUTPUT_BATCH_MAX_CHARS) {
        flush()
        return
      }
      if (!timer) {
        // Why: Paseo coalesces terminal stream output before crossing the
        // network. Desktop runtime subscribers need the same burst boundary.
        timer = setTimeout(flush, TERMINAL_OUTPUT_FLUSH_MS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      }
    },
    flush,
    dispose(): void {
      clearTimer()
      chunks = []
      chars = 0
    }
  }
}

function isTerminalInputLockedForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  client: TerminalViewportClient | undefined
): boolean {
  if (client?.type === 'mobile') {
    return false
  }
  // Why: pre-refactor mobile builds did not send client metadata. Desktop
  // callers we control now identify as desktop, so keep legacy mobile input
  // working without opening the new desktop path.
  if (!client) {
    return false
  }
  return runtime.getDriver(ptyId).kind === 'mobile'
}

function resolveMobileFloorClientId(
  driver: DriverState | null,
  client: TerminalViewportClient | undefined
): string | null {
  if (client?.type === 'mobile') {
    return client.id
  }
  if (!client && driver?.kind === 'mobile') {
    return driver.clientId
  }
  return null
}

function appendPendingMultiplexOutput(stream: TerminalMultiplexStream, data: string): void {
  stream.pendingOutput.push(data)
  stream.pendingOutputChars += data.length
  while (
    stream.pendingOutputChars > TERMINAL_MULTIPLEX_PENDING_MAX_CHARS &&
    stream.pendingOutput.length > 0
  ) {
    stream.pendingOutputChars -= stream.pendingOutput.shift()?.length ?? 0
  }
}

function sendSnapshotFrames(
  sendFrame: (opcode: TerminalStreamOpcode, payload?: Uint8Array<ArrayBufferLike>) => void,
  options: SnapshotFrameOptions
): { bytes: number; chunks: number } {
  sendFrame(
    TerminalStreamOpcode.SnapshotStart,
    encodeTerminalStreamJson({
      kind: options.kind,
      cols: options.cols,
      rows: options.rows,
      displayMode: options.displayMode,
      reason: options.reason,
      seq: options.seq,
      truncated: options.truncated === true,
      truncatedByByteBudget: options.truncatedByByteBudget === true
    })
  )
  const bytes = encodeTerminalStreamText(options.data)
  let chunks = 0
  for (let offset = 0; offset < bytes.length; offset += TERMINAL_STREAM_CHUNK_BYTES) {
    chunks++
    sendFrame(
      TerminalStreamOpcode.SnapshotChunk,
      bytes.slice(offset, offset + TERMINAL_STREAM_CHUNK_BYTES)
    )
  }
  sendFrame(TerminalStreamOpcode.SnapshotEnd)
  return { bytes: bytes.byteLength, chunks }
}

async function serializeBudgetedMobileSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  isMobile: boolean
): Promise<SerializedSnapshot> {
  if (!isMobile) {
    const serialized = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: 0 })
    return serialized ? { ...serialized, scrollbackRows: 0, truncatedByByteBudget: false } : null
  }
  const candidates = [MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, 500, 250, 100, 25, 0]
  for (const rows of candidates) {
    const serialized = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: rows })
    if (!serialized) {
      return null
    }
    const bytes = new TextEncoder().encode(serialized.data).byteLength
    if (bytes <= MOBILE_SNAPSHOT_BYTE_BUDGET || rows === 0) {
      return {
        ...serialized,
        scrollbackRows: rows,
        truncatedByByteBudget:
          rows < MOBILE_SUBSCRIBE_SCROLLBACK_ROWS || bytes > MOBILE_SNAPSHOT_BYTE_BUDGET
      }
    }
  }
  return null
}

async function updateViewportForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  client: TerminalViewportClient,
  viewport: { cols: number; rows: number },
  defaultType: 'mobile' | 'desktop'
): Promise<boolean> {
  const type = client.type ?? defaultType
  if (type === 'mobile') {
    return runtime.updateMobileViewport(ptyId, client.id, viewport)
  }
  return runtime.updateDesktopViewport(ptyId, viewport)
}

const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle')
})

const TerminalListParams = z.object({
  worktree: OptionalString,
  limit: OptionalFiniteNumber
})

const TerminalResolveActive = z.object({
  worktree: OptionalString
})

const TerminalRead = TerminalHandle.extend({
  cursor: z
    .unknown()
    .transform((value) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return Number.NaN
      }
      return value
    })
    .pipe(
      z
        .number()
        .optional()
        .refine((v) => v === undefined || Number.isFinite(v), {
          message: 'Cursor must be a non-negative integer'
        })
    )
    .optional()
})

// Why: the legacy handler allowed `title: string | null` and rejected every
// other shape (including `undefined`) with a specific message, which is how
// the CLI signals an intentional "reset". Preserve that distinction exactly.
const TerminalRename = TerminalHandle.extend({
  title: z.custom<string | null>((value) => value === null || typeof value === 'string', {
    message: 'Missing --title (pass empty string or null to reset)'
  })
})

const TerminalSend = TerminalHandle.extend({
  text: OptionalString,
  enter: z.unknown().optional(),
  interrupt: z.unknown().optional(),
  // Why: identifies the caller for the driver state machine. Optional for
  // backward compatibility with older mobile clients (server falls back to
  // the most recent mobile actor when absent). New mobile builds populate
  // this so multi-mobile semantics resolve correctly. See
  // docs/mobile-presence-lock.md.
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional()
})

const TerminalViewport = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500)
})

const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})

const TerminalCreateParams = z.object({
  worktree: OptionalString,
  command: OptionalString,
  env: z.record(z.string(), z.string()).optional(),
  title: OptionalString,
  focus: z.unknown().optional()
})

const TerminalSplit = TerminalHandle.extend({
  direction: z
    .unknown()
    .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
    .pipe(z.union([z.enum(['vertical', 'horizontal']), z.undefined()]))
    .optional(),
  command: OptionalString
})

const TerminalStop = z.object({
  worktree: requiredString('Missing worktree selector')
})

const TerminalResizeForClient = z.discriminatedUnion('mode', [
  z.object({
    terminal: requiredString('Missing terminal handle'),
    mode: z.literal('mobile-fit'),
    cols: z.number().finite().positive(),
    rows: z.number().finite().positive(),
    clientId: requiredString('Missing client ID')
  }),
  z.object({
    terminal: requiredString('Missing terminal handle'),
    mode: z.literal('restore'),
    clientId: requiredString('Missing client ID')
  })
])

const TerminalSubscribe = TerminalHandle.extend({
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional(),
  capabilities: z
    .object({
      terminalBinaryStream: z.literal(1).optional()
    })
    .optional()
})

const TerminalMultiplex = z.object({})

const TerminalMultiplexSubscribeFrame = TerminalHandle.extend({
  streamId: z.number().int().min(1),
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional()
})

const TerminalSetDisplayMode = TerminalHandle.extend({
  // Why: 'phone' was previously a "stay at phone dims after unsubscribe"
  // mode that the toggle UI never produced and nothing in product
  // depended on. Removed in favor of two clean modes: 'auto' (mobile
  // drives dims while subscribed, desktop restores on last-leave) and
  // 'desktop' (no resize, mobile scales the wide canvas down to fit).
  mode: z.enum(['auto', 'desktop']),
  // Why: identifies the caller for the driver state machine. Optional for
  // backward compatibility with older mobile clients.
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  // Why: subscribers that registered before viewport was measured have
  // a null viewport on their record. Toggling to 'auto' would no-op
  // because applyMobileDisplayMode skips phone-fit when viewport is
  // missing. Allow the toggle to carry the latest measured viewport so
  // the server can store it on the subscriber record before fitting.
  viewport: z
    .object({
      cols: z.number().int().positive(),
      rows: z.number().int().positive()
    })
    .optional()
})

const TerminalUnsubscribe = z.object({
  subscriptionId: requiredString('Missing subscription ID'),
  // Why: required when subscribe registered the cleanup under the composite
  // key `${terminal}:${clientId}`. If the caller passes a bare-handle
  // subscriptionId (older clients), the server reconstructs the composite
  // key from `client.id`. See docs/mobile-presence-lock.md.
  client: z
    .object({
      id: requiredString('Missing client ID')
    })
    .optional()
})

// Why: in-place viewport update for an existing mobile subscription. Used
// when the keyboard opens/closes on the mobile client and the visible
// terminal area changes — without this, the mobile app had to
// unsubscribe → resubscribe, which (a) flashed the desktop lock banner
// during the brief idle gap and (b) caused the new subscribe to capture
// the already-phone-fitted PTY size as its restore baseline, leaving the
// PTY stuck at phone dims after the phone disconnected. See
// docs/mobile-presence-lock.md.
const TerminalUpdateViewport = TerminalHandle.extend({
  client: z.object({
    id: requiredString('Missing client ID'),
    type: z.enum(['mobile', 'desktop']).default('mobile').optional()
  }),
  viewport: z.object({
    cols: z.number().int().min(20).max(240),
    rows: z.number().int().min(8).max(120)
  })
})

// Why: phone-fit auto-restore preference (docs/mobile-fit-hold.md). `null`
// means Indefinite; finite millisecond values are clamped server-side
// into [5_000, 60min] before persistence.
const TerminalSetAutoRestoreFit = z.object({
  ms: z.number().nullable()
})

export const TERMINAL_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.list',
    params: TerminalListParams,
    handler: async (params, { runtime }) => runtime.listTerminals(params.worktree, params.limit)
  }),
  defineMethod({
    name: 'terminal.resolveActive',
    params: TerminalResolveActive,
    handler: async (params, { runtime }) => ({
      handle: await runtime.resolveActiveTerminal(params.worktree)
    })
  }),
  defineMethod({
    name: 'terminal.show',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.showTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.read',
    params: TerminalRead,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.readTerminal(params.terminal, { cursor: params.cursor })
    })
  }),
  defineMethod({
    name: 'terminal.inspectProcess',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      process: await runtime.inspectTerminalProcess(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.rename',
    params: TerminalRename,
    handler: async (params, { runtime }) => ({
      rename: await runtime.renameTerminal(params.terminal, params.title || null)
    })
  }),
  defineMethod({
    name: 'terminal.clearBuffer',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      clear: await runtime.clearTerminalBuffer(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.send',
    params: TerminalSend,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      const driver = leaf?.ptyId ? runtime.getDriver(leaf.ptyId) : null
      if (leaf?.ptyId && isTerminalInputLockedForClient(runtime, leaf.ptyId, params.client)) {
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      const result = await runtime.sendTerminal(params.terminal, {
        text: params.text,
        enter: params.enter === true,
        interrupt: params.interrupt === true
      })
      // Why: deliberate mobile input is a take-floor action. Drives the
      // `* → mobile{clientId}` driver transition so the desktop banner
      // remounts (if previously reclaimed) and active phone-fit dims follow
      // the most recent actor. Clientless sends are old mobile builds, so use
      // the current mobile driver as their compatibility identity.
      const mobileFloorClientId = resolveMobileFloorClientId(driver, params.client)
      if (leaf?.ptyId && mobileFloorClientId) {
        await runtime.mobileTookFloor(leaf.ptyId, mobileFloorClientId)
      }
      return { send: result }
    }
  }),
  defineMethod({
    name: 'terminal.wait',
    params: TerminalWait,
    handler: async (params, { runtime }) => ({
      wait: await runtime.waitForTerminal(params.terminal, {
        condition: params.for,
        timeoutMs: params.timeoutMs
      })
    })
  }),
  defineMethod({
    name: 'terminal.create',
    params: TerminalCreateParams,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.createTerminal(params.worktree, {
        command: params.command,
        env: params.env,
        title: params.title,
        focus: params.focus === true
      })
    })
  }),
  defineMethod({
    name: 'terminal.split',
    params: TerminalSplit,
    handler: async (params, { runtime }) => ({
      split: await runtime.splitTerminal(params.terminal, {
        direction: params.direction,
        command: params.command
      })
    })
  }),
  defineMethod({
    name: 'terminal.stop',
    params: TerminalStop,
    handler: async (params, { runtime }) => runtime.stopTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.resizeForClient',
    params: TerminalResizeForClient,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const result = await runtime.resizeForClient(
        leaf.ptyId,
        params.mode,
        params.clientId,
        params.mode === 'mobile-fit' ? params.cols : undefined,
        params.mode === 'mobile-fit' ? params.rows : undefined
      )
      return {
        terminal: {
          handle: params.terminal,
          ...result
        }
      }
    }
  }),
  defineMethod({
    name: 'terminal.focus',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      focus: await runtime.focusTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.close',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      close: await runtime.closeTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.setDisplayMode',
    params: TerminalSetDisplayMode,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      // Why: late-bind viewport for callers that subscribed in desktop
      // mode (no viewport stored). Without this, a 'auto' toggle on a
      // viewport-less record skips phone-fit and the user sees no resize.
      if (params.viewport && params.client?.id) {
        runtime.updateMobileSubscriberViewport(leaf.ptyId, params.client.id, params.viewport)
      }
      runtime.setMobileDisplayMode(leaf.ptyId, params.mode)
      await runtime.applyMobileDisplayMode(leaf.ptyId)
      // Why: a deliberate mobile mode change is a take-floor action when
      // moving to auto/phone (the user explicitly chose to drive at phone
      // dims). Setting mode to desktop is intentionally NOT a take-floor
      // action — that's a "watch from desktop dims" gesture.
      if (params.client && params.client.type === 'mobile' && params.mode !== 'desktop') {
        await runtime.mobileTookFloor(leaf.ptyId, params.client.id)
      }
      return { mode: params.mode, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  }),
  defineMethod({
    name: 'terminal.restoreFit',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      return { restored: await runtime.reclaimTerminalForDesktop(leaf.ptyId) }
    }
  }),
  defineMethod({
    name: 'terminal.getDisplayMode',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      const mode = leaf?.ptyId ? runtime.getMobileDisplayMode(leaf.ptyId) : 'auto'
      const isPhoneFitted = leaf?.ptyId ? runtime.isMobileSubscriberActive(leaf.ptyId) : false
      return { mode, isPhoneFitted }
    }
  }),
  defineMethod({
    name: 'terminal.updateViewport',
    params: TerminalUpdateViewport,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const updated = await updateViewportForClient(
        runtime,
        leaf.ptyId,
        params.client,
        params.viewport,
        'mobile'
      )
      return { updated, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  }),
  // Why: desktop remote sessions can have dozens of panes. One streaming RPC
  // owns the binary socket and routes terminal slots by streamId, mirroring
  // Paseo's slot-based terminal data plane while keeping legacy subscribe as
  // the compatibility fallback.
  defineStreamingMethod({
    name: 'terminal.multiplex',
    params: TerminalMultiplex,
    handler: async (
      _params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler },
      emit
    ) => {
      if (!sendBinary || !registerBinaryStreamHandler || !connectionId) {
        throw new Error('binary_terminal_stream_required')
      }

      let closed = false
      let cursor = 0
      const streams = new Map<number, TerminalMultiplexStream>()
      let resolveMultiplex = (): void => {}
      const multiplexClosed = new Promise<void>((resolve) => {
        resolveMultiplex = resolve
      })
      const sendFrame = (
        streamId: number,
        opcode: TerminalStreamOpcode,
        payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
      ): void => {
        if (closed) {
          return
        }
        sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: cursor++, payload }))
      }
      const sendStreamError = (streamId: number, message: string): void => {
        sendFrame(streamId, TerminalStreamOpcode.Error, encodeTerminalStreamText(message))
        emit({ type: 'error', streamId, message })
      }
      const detachStream = (streamId: number, emitEnd: boolean): void => {
        const stream = streams.get(streamId)
        if (!stream) {
          return
        }
        stream.outputBatcher.flush()
        stream.outputBatcher.dispose()
        stream.unsubscribeData()
        stream.unsubscribeResize()
        stream.unsubscribeFit()
        stream.unsubscribeDriver()
        stream.unregisterBinaryHandler()
        streams.delete(streamId)
        if (stream.isMobile && stream.client?.id) {
          runtime.handleMobileUnsubscribe(stream.ptyId, stream.client.id)
        }
        if (emitEnd) {
          emit({ type: 'end', streamId })
        }
      }
      const closeMultiplex = (): void => {
        if (closed) {
          return
        }
        closed = true
        for (const streamId of Array.from(streams.keys())) {
          detachStream(streamId, false)
        }
        unregisterControlHandler()
        resolveMultiplex()
      }
      const handleSlotFrame = (
        stream: TerminalMultiplexStream,
        frame: TerminalStreamFrame
      ): void => {
        if (closed || streams.get(stream.streamId) !== stream) {
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
          detachStream(stream.streamId, false)
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Input) {
          const text = decodeTerminalStreamText(frame.payload)
          if (!text) {
            return
          }
          if (isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
            return
          }
          void runtime
            .sendTerminal(stream.terminal, { text, enter: false, interrupt: false })
            .then(async () => {
              if (stream.isMobile && stream.client?.id) {
                await runtime.mobileTookFloor(stream.ptyId, stream.client.id)
              }
            })
            .catch(() => {})
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Resize && stream.client) {
          const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(
            frame.payload
          )
          if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
            return
          }
          void updateViewportForClient(
            runtime,
            stream.ptyId,
            stream.client,
            { cols: viewport.cols, rows: viewport.rows },
            stream.isMobile ? 'mobile' : 'desktop'
          ).catch(() => {})
        }
      }
      const handleSubscribeFrame = async (payload: Uint8Array<ArrayBufferLike>): Promise<void> => {
        const raw = decodeTerminalStreamJson<unknown>(payload)
        const parsed = TerminalMultiplexSubscribeFrame.safeParse(raw)
        if (!parsed.success) {
          return
        }
        const request = parsed.data
        detachStream(request.streamId, false)

        let leaf = runtime.resolveLeafForHandle(request.terminal)
        const isMobile = request.client?.type === 'mobile'
        if (!leaf?.ptyId && isMobile) {
          try {
            const ptyId = await runtime.waitForLeafPtyId(request.terminal)
            leaf = { ptyId }
          } catch {
            // Fall through to the explicit no_connected_pty error below.
          }
        }
        if (!leaf?.ptyId) {
          sendStreamError(request.streamId, 'no_connected_pty')
          emit({ type: 'end', streamId: request.streamId })
          return
        }

        const ptyId = leaf.ptyId
        const stream: TerminalMultiplexStream = {
          streamId: request.streamId,
          terminal: request.terminal,
          ptyId,
          client: request.client,
          isMobile,
          buffering: true,
          pendingOutput: [],
          pendingOutputChars: 0,
          outputBatcher: createTerminalOutputBatcher((data) => {
            sendFrame(request.streamId, TerminalStreamOpcode.Output, encodeTerminalStreamText(data))
          }),
          unsubscribeData: () => {},
          unsubscribeResize: () => {},
          unsubscribeFit: () => {},
          unsubscribeDriver: () => {},
          unregisterBinaryHandler: () => {}
        }
        streams.set(request.streamId, stream)
        stream.unregisterBinaryHandler = registerBinaryStreamHandler(request.streamId, (frame) =>
          handleSlotFrame(stream, frame)
        )

        try {
          stream.unsubscribeData = runtime.subscribeToTerminalData(ptyId, (data) => {
            if (closed || streams.get(request.streamId) !== stream) {
              return
            }
            if (stream.buffering) {
              appendPendingMultiplexOutput(stream, data)
              return
            }
            stream.outputBatcher.push(data)
          })

          if (isMobile && request.client?.id) {
            await runtime.handleMobileSubscribe(ptyId, request.client.id, request.viewport)
          } else if (request.viewport && request.client) {
            await updateViewportForClient(
              runtime,
              ptyId,
              request.client,
              request.viewport,
              'desktop'
            )
          }
          if (closed || streams.get(request.streamId) !== stream) {
            return
          }

          if (!isMobile) {
            stream.unsubscribeFit = runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
              emit({
                type: 'fit-override-changed',
                streamId: request.streamId,
                mode: event.mode,
                cols: event.cols,
                rows: event.rows
              })
            })
            stream.unsubscribeDriver = runtime.subscribeToDriverChanges(ptyId, (driver) => {
              emit({
                type: 'driver-changed',
                streamId: request.streamId,
                driver
              })
            })
          }

          const read = await runtime.readTerminal(request.terminal)
          const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
          if (closed || streams.get(request.streamId) !== stream) {
            return
          }
          const size = runtime.getTerminalSize(ptyId)
          const displayMode = runtime.getMobileDisplayMode(ptyId)
          const seq = runtime.getLayout(ptyId)?.seq
          if (!isMobile) {
            const fitOverride = runtime.getTerminalFitOverride(ptyId)
            emit({
              type: 'fit-override-changed',
              streamId: request.streamId,
              mode: fitOverride?.mode ?? 'desktop-fit',
              cols: fitOverride?.cols ?? size?.cols ?? 0,
              rows: fitOverride?.rows ?? size?.rows ?? 0
            })
            emit({
              type: 'driver-changed',
              streamId: request.streamId,
              driver: runtime.getDriver(ptyId)
            })
          }
          emit({
            type: 'subscribed',
            streamId: request.streamId,
            terminal: request.terminal,
            cols: serialized?.cols ?? size?.cols,
            rows: serialized?.rows ?? size?.rows,
            displayMode,
            seq,
            truncated: read.truncated
          })
          sendSnapshotFrames((opcode, payload) => sendFrame(request.streamId, opcode, payload), {
            kind: 'scrollback',
            cols: serialized?.cols ?? size?.cols ?? 80,
            rows: serialized?.rows ?? size?.rows ?? 24,
            displayMode,
            seq,
            truncated: read.truncated,
            truncatedByByteBudget: serialized?.truncatedByByteBudget,
            data: serialized?.data ?? (read.tail.length > 0 ? `${read.tail.join('\r\n')}\r\n` : '')
          })
          stream.buffering = false
          for (const data of stream.pendingOutput.splice(0)) {
            stream.outputBatcher.push(data)
          }
          stream.pendingOutputChars = 0
          stream.outputBatcher.flush()

          stream.unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
            stream.outputBatcher.flush()
            sendFrame(
              request.streamId,
              TerminalStreamOpcode.Resized,
              encodeTerminalStreamJson({
                cols: event.cols,
                rows: event.rows,
                displayMode: event.displayMode,
                reason: event.reason,
                seq: event.seq
              })
            )
          })
          void runtime
            .waitForTerminal(request.terminal, { condition: 'exit' })
            .then(() => {
              if (streams.get(request.streamId) === stream) {
                detachStream(request.streamId, true)
              }
            })
            .catch(() => {
              if (streams.get(request.streamId) === stream) {
                detachStream(request.streamId, true)
              }
            })
        } catch (error) {
          detachStream(request.streamId, false)
          sendStreamError(request.streamId, error instanceof Error ? error.message : String(error))
          emit({ type: 'end', streamId: request.streamId })
        }
      }
      const unregisterControlHandler = registerBinaryStreamHandler(0, (frame) => {
        if (frame.opcode !== TerminalStreamOpcode.Subscribe) {
          return
        }
        void handleSubscribeFrame(frame.payload)
      })

      runtime.registerSubscriptionCleanup(
        `terminal-multiplex:${connectionId}`,
        closeMultiplex,
        connectionId
      )
      emit({ type: 'ready' })
      await multiplexClosed
    }
  }),
  // Why: terminal.subscribe streams live terminal output over WebSocket.
  // It sends initial scrollback, then live data chunks as they arrive.
  // Mobile clients pass client+viewport params for server-side auto-fit.
  defineStreamingMethod({
    name: 'terminal.subscribe',
    params: TerminalSubscribe,
    handler: async (
      params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler },
      emit
    ) => {
      let leaf = runtime.resolveLeafForHandle(params.terminal)
      const isMobile = params.client?.type === 'mobile'
      const useBinaryStream = params.capabilities?.terminalBinaryStream === 1 && Boolean(sendBinary)

      // Why: the left pane's PTY spawns asynchronously after the tab is created.
      // Mobile clients that subscribe before the PTY is ready would get a bare
      // scrollback+end with no live stream or phone-fit. Wait for the PTY so
      // the subscribe can proceed normally.
      if (!leaf?.ptyId && isMobile) {
        try {
          const ptyId = await runtime.waitForLeafPtyId(params.terminal)
          leaf = { ptyId }
        } catch {
          // PTY wait timed out — fall through to scrollback-only path below
        }
      }

      if (!leaf?.ptyId) {
        const read = await runtime.readTerminal(params.terminal)
        emit({ type: 'subscribed', streamId: null, lines: read.tail, truncated: read.truncated })
        emit({ type: 'end' })
        return
      }

      if (isMobile && (!useBinaryStream || !sendBinary)) {
        throw new Error('binary_terminal_stream_required')
      }

      const ptyId = leaf.ptyId
      const clientId = params.client?.id
      if (!useBinaryStream) {
        const read = await runtime.readTerminal(params.terminal)
        const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, false)
        const size = runtime.getTerminalSize(ptyId)
        const displayMode = runtime.getMobileDisplayMode(ptyId)
        const seq = runtime.getLayout(ptyId)?.seq
        emit({
          type: 'scrollback',
          lines: read.tail,
          truncated: read.truncated,
          serialized: serialized?.data,
          cols: serialized?.cols ?? size?.cols,
          rows: serialized?.rows ?? size?.rows,
          displayMode,
          seq
        })

        // Why: desktop can have both a hidden automation watcher and a visible
        // pane subscribed to the same terminal. Key by client when provided so
        // one stream cannot evict the other.
        const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
        await new Promise<void>((resolve) => {
          const outputBatcher = createTerminalOutputBatcher((chunk) => {
            emit({ type: 'data', chunk })
          })
          const unsubscribeData = runtime.subscribeToTerminalData(ptyId, (data) => {
            outputBatcher.push(data)
          })
          const unsubscribeFit = runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
            outputBatcher.flush()
            emit({
              type: 'fit-override-changed',
              mode: event.mode,
              cols: event.cols,
              rows: event.rows
            })
          })
          runtime.registerSubscriptionCleanup(
            subscriptionId,
            () => {
              outputBatcher.flush()
              outputBatcher.dispose()
              unsubscribeData()
              unsubscribeFit()
              emit({ type: 'end' })
              resolve()
            },
            connectionId
          )
          void runtime
            .waitForTerminal(params.terminal, { condition: 'exit' })
            .then(() => runtime.cleanupSubscription(subscriptionId))
            .catch(() => runtime.cleanupSubscription(subscriptionId))
        })
        return
      }

      const streamId = nextTerminalStreamId++
      let cursor = 0
      let closed = false
      let buffering = true
      const pendingOutput: string[] = []
      let pendingOutputChars = 0
      let unsubscribeData = (): void => {}
      let unsubscribeResize = (): void => {}
      let unsubscribeFit = (): void => {}
      let unregisterBinaryHandler = (): void => {}
      let outputBatcher: ReturnType<typeof createTerminalOutputBatcher> | null = null
      let resolveStream = (): void => {}
      const streamClosed = new Promise<void>((resolve) => {
        resolveStream = resolve
      })
      // Why: register cleanup before any mobile-fit or snapshot await. A phone
      // can disconnect mid-subscribe; cleanup must still remove mobile
      // presence. Client-scoped ids also allow parallel desktop subscribers.
      const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          outputBatcher?.flush()
          outputBatcher?.dispose()
          closed = true
          unsubscribeData()
          unsubscribeResize()
          unsubscribeFit()
          unregisterBinaryHandler()
          if (isMobile && clientId) {
            runtime.handleMobileUnsubscribe(ptyId, clientId)
          }
          emit({ type: 'end' })
          resolveStream()
        },
        connectionId
      )
      void runtime
        .waitForTerminal(params.terminal, { condition: 'exit' })
        .then(() => runtime.cleanupSubscription(subscriptionId))
        .catch(() => runtime.cleanupSubscription(subscriptionId))
      const sendFrame = (
        opcode: TerminalStreamOpcode,
        payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
      ): void => {
        if (closed || !sendBinary) {
          return
        }
        sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: cursor++, payload }))
      }
      outputBatcher = createTerminalOutputBatcher((data) => {
        sendFrame(TerminalStreamOpcode.Output, encodeTerminalStreamText(data))
      })
      unregisterBinaryHandler =
        registerBinaryStreamHandler?.(streamId, (frame) => {
          if (closed) {
            return
          }
          if (frame.opcode === TerminalStreamOpcode.Input) {
            const text = decodeTerminalStreamText(frame.payload)
            if (!text) {
              return
            }
            if (isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
              return
            }
            void runtime
              .sendTerminal(params.terminal, { text, enter: false, interrupt: false })
              .then(async () => {
                if (isMobile && clientId) {
                  await runtime.mobileTookFloor(ptyId, clientId)
                }
              })
              .catch(() => {})
            return
          }
          if (frame.opcode === TerminalStreamOpcode.Resize && params.client) {
            const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(
              frame.payload
            )
            if (
              !viewport ||
              typeof viewport.cols !== 'number' ||
              typeof viewport.rows !== 'number'
            ) {
              return
            }
            void updateViewportForClient(
              runtime,
              ptyId,
              params.client,
              { cols: viewport.cols, rows: viewport.rows },
              'desktop'
            ).catch(() => {})
          }
        }) ?? (() => {})
      // Server-side auto-fit: resize PTY to phone dims before serializing scrollback
      try {
        if (isMobile && clientId) {
          await runtime.handleMobileSubscribe(ptyId, clientId, params.viewport)
        }
        if (closed) {
          return
        }

        unsubscribeData = runtime.subscribeToTerminalData(ptyId, (data) => {
          if (closed) {
            return
          }
          if (buffering) {
            pendingOutput.push(data)
            pendingOutputChars += data.length
            while (
              pendingOutputChars > TERMINAL_MULTIPLEX_PENDING_MAX_CHARS &&
              pendingOutput.length > 0
            ) {
              pendingOutputChars -= pendingOutput.shift()?.length ?? 0
            }
            return
          }
          outputBatcher?.push(data)
        })

        const read = await runtime.readTerminal(params.terminal)
        const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
        if (closed) {
          return
        }
        const size = runtime.getTerminalSize(ptyId)
        const displayMode = runtime.getMobileDisplayMode(ptyId)
        // Why: emit the current layout seq with the initial scrollback so
        // the mobile client's stale-event filter knows the high-water mark.
        // Undefined when the PTY has never transitioned (filter is fail-open).
        // See docs/mobile-terminal-layout-state-machine.md.
        const seq = runtime.getLayout(ptyId)?.seq
        emit({
          type: 'subscribed',
          streamId,
          lines: read.tail,
          truncated: read.truncated,
          cols: serialized?.cols ?? size?.cols,
          rows: serialized?.rows ?? size?.rows,
          displayMode,
          seq
        })
        const snapshotStats = sendSnapshotFrames(sendFrame, {
          kind: 'scrollback',
          cols: serialized?.cols ?? size?.cols ?? 80,
          rows: serialized?.rows ?? size?.rows ?? 24,
          displayMode,
          seq,
          truncated: read.truncated,
          truncatedByByteBudget: serialized?.truncatedByByteBudget,
          data: serialized?.data ?? ''
        })
        console.log('[mobile-terminal-stream] snapshot', {
          terminal: params.terminal,
          streamId,
          kind: 'scrollback',
          bytes: snapshotStats.bytes,
          chunks: snapshotStats.chunks,
          scrollbackRows: serialized?.scrollbackRows,
          truncatedByByteBudget: serialized?.truncatedByByteBudget === true
        })
        buffering = false
        for (const item of pendingOutput.splice(0)) {
          outputBatcher.push(item)
        }
        pendingOutputChars = 0
        outputBatcher.flush()

        unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
          // Why: true PTY geometry changes should be followed by the TUI's
          // redraw output, not a full scrollback replay. The client resizes
          // xterm geometry and consumes subsequent live output on this stream.
          outputBatcher?.flush()
          sendFrame(
            TerminalStreamOpcode.Resized,
            encodeTerminalStreamJson({
              cols: event.cols,
              rows: event.rows,
              displayMode: event.displayMode,
              reason: event.reason,
              seq: event.seq
            })
          )
        })

        // Legacy fit-override-changed for non-mobile (desktop) subscribers
        unsubscribeFit = !isMobile
          ? runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
              emit({
                type: 'fit-override-changed',
                mode: event.mode,
                cols: event.cols,
                rows: event.rows
              })
            })
          : () => {}
      } catch (error) {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      }

      await streamClosed
    }
  }),
  defineMethod({
    name: 'terminal.unsubscribe',
    params: TerminalUnsubscribe,
    handler: async (params, { runtime }) => {
      // Why: the subscribe handler now registers cleanup under a composite
      // key `${terminal}:${clientId}`. New mobile builds emit the composite
      // key directly. Older builds emit a bare-handle subscriptionId; if
      // they additionally provide `client.id`, reconstruct the composite
      // key server-side. We always try the as-sent value first, then fall
      // back to the reconstructed composite, so both wire formats work.
      runtime.cleanupSubscription(params.subscriptionId)
      if (params.client && !params.subscriptionId.includes(':')) {
        runtime.cleanupSubscription(`${params.subscriptionId}:${params.client.id}`)
      }
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'terminal.getAutoRestoreFit',
    params: z.object({}),
    handler: async (_params, { runtime }) => ({
      ms: runtime.getMobileAutoRestoreFitMs()
    })
  }),
  defineMethod({
    name: 'terminal.setAutoRestoreFit',
    params: TerminalSetAutoRestoreFit,
    handler: async (params, { runtime }) => ({
      ms: runtime.setMobileAutoRestoreFitMs(params.ms)
    })
  })
]

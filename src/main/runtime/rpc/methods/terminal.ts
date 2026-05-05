/* oxlint-disable max-lines -- Why: terminal RPC methods are co-located for discoverability; splitting would scatter related handlers across files. */
import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

// Why: when a mobile client subscribes the server resizes the PTY to phone
// dims and serializes the buffer. Sending only the visible screen meant
// users coming back to the app or switching terminals could no longer scroll
// up to see prior agent output. Include enough scrollback to keep typical
// agent runs (Claude Code chats, command output) reachable. The mobile
// WebView's xterm has a 5000-row buffer so this fits comfortably.
const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000

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

const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})

const TerminalCreateParams = z.object({
  worktree: OptionalString,
  command: OptionalString,
  title: OptionalString
})

const TerminalSplit = TerminalHandle.extend({
  direction: z
    .unknown()
    .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
    .pipe(z.enum(['vertical', 'horizontal']).optional()),
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
  viewport: z
    .object({
      cols: z.number().int().min(20).max(240),
      rows: z.number().int().min(8).max(120)
    })
    .optional()
})

const TerminalSetDisplayMode = TerminalHandle.extend({
  mode: z.enum(['auto', 'phone', 'desktop']),
  // Why: identifies the caller for the driver state machine. Optional for
  // backward compatibility with older mobile clients.
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
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
    name: 'terminal.rename',
    params: TerminalRename,
    handler: async (params, { runtime }) => ({
      rename: await runtime.renameTerminal(params.terminal, params.title || null)
    })
  }),
  defineMethod({
    name: 'terminal.send',
    params: TerminalSend,
    handler: async (params, { runtime }) => {
      const result = await runtime.sendTerminal(params.terminal, {
        text: params.text,
        enter: params.enter === true,
        interrupt: params.interrupt === true
      })
      // Why: deliberate mobile input is a take-floor action. Drives the
      // `* → mobile{clientId}` driver transition so the desktop banner
      // remounts (if previously reclaimed) and active phone-fit dims follow
      // the most recent actor. Only mobile-typed callers take the floor;
      // desktop callers (CLI / agents) do not. Older mobile builds without
      // a `client` field continue to work — the runtime then keeps the
      // current driver state.
      if (params.client && params.client.type === 'mobile') {
        const leaf = runtime.resolveLeafForHandle(params.terminal)
        if (leaf?.ptyId) {
          runtime.mobileTookFloor(leaf.ptyId, params.client.id)
        }
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
        title: params.title
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
      const result = runtime.resizeForClient(
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
      runtime.setMobileDisplayMode(leaf.ptyId, params.mode)
      runtime.applyMobileDisplayMode(leaf.ptyId)
      // Why: a deliberate mobile mode change is a take-floor action when
      // moving to auto/phone (the user explicitly chose to drive at phone
      // dims). Setting mode to desktop is intentionally NOT a take-floor
      // action — that's a "watch from desktop dims" gesture.
      if (params.client && params.client.type === 'mobile' && params.mode !== 'desktop') {
        runtime.mobileTookFloor(leaf.ptyId, params.client.id)
      }
      return { mode: params.mode }
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
      const updated = runtime.updateMobileViewport(leaf.ptyId, params.client.id, params.viewport)
      return { updated }
    }
  }),
  // Why: terminal.subscribe streams live terminal output over WebSocket.
  // It sends initial scrollback, then live data chunks as they arrive.
  // Mobile clients pass client+viewport params for server-side auto-fit.
  defineStreamingMethod({
    name: 'terminal.subscribe',
    params: TerminalSubscribe,
    handler: async (params, { runtime }, emit) => {
      let leaf = runtime.resolveLeafForHandle(params.terminal)
      const isMobile = params.client?.type === 'mobile'

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
        emit({
          type: 'scrollback',
          lines: read.tail,
          truncated: read.truncated,
          serialized: undefined,
          cols: undefined,
          rows: undefined
        })
        emit({ type: 'end' })
        return
      }

      const ptyId = leaf.ptyId
      const clientId = params.client?.id

      // Server-side auto-fit: resize PTY to phone dims before serializing scrollback
      if (isMobile && clientId) {
        runtime.handleMobileSubscribe(ptyId, clientId, params.viewport)
      }

      const read = await runtime.readTerminal(params.terminal)
      const serialized = await runtime.serializeTerminalBuffer(ptyId, {
        scrollbackRows: isMobile ? MOBILE_SUBSCRIBE_SCROLLBACK_ROWS : 0
      })
      const size = runtime.getTerminalSize(ptyId)
      const displayMode = runtime.getMobileDisplayMode(ptyId)
      emit({
        type: 'scrollback',
        lines: read.tail,
        truncated: read.truncated,
        serialized: serialized?.data,
        cols: serialized?.cols ?? size?.cols,
        rows: serialized?.rows ?? size?.rows,
        displayMode
      })

      await new Promise<void>((resolve) => {
        const unsubscribeData = runtime.subscribeToTerminalData(ptyId, (data) => {
          emit({ type: 'data', chunk: data })
        })

        // Inline resize events replace the old fit-override-changed event for
        // mobile clients. They include fresh serialized scrollback so the client
        // can reinitialize xterm without resubscribing.
        const unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, async (event) => {
          // Why: mobile subscriptions need the same scrollback on inline
          // resize as on initial subscribe — without it, toggling phone/desktop
          // mode or the keyboard-driven refit would silently wipe history.
          const fresh = await runtime.serializeTerminalBuffer(ptyId, {
            scrollbackRows: isMobile ? MOBILE_SUBSCRIBE_SCROLLBACK_ROWS : 0
          })
          emit({
            type: 'resized',
            cols: event.cols,
            rows: event.rows,
            serialized: fresh?.data,
            displayMode: event.displayMode,
            reason: event.reason
          })
        })

        // Legacy fit-override-changed for non-mobile (desktop) subscribers
        const unsubscribeFit = !isMobile
          ? runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
              emit({
                type: 'fit-override-changed',
                mode: event.mode,
                cols: event.cols,
                rows: event.rows
              })
            })
          : () => {}

        // Why: composite subscriptionId per (terminal, clientId) so two
        // mobile clients subscribing to the same terminal handle do not
        // evict each other via registerSubscriptionCleanup's
        // duplicate-key cleanup. See docs/mobile-presence-lock.md.
        const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
        runtime.registerSubscriptionCleanup(subscriptionId, () => {
          unsubscribeData()
          unsubscribeResize()
          unsubscribeFit()
          if (isMobile && clientId) {
            runtime.handleMobileUnsubscribe(ptyId, clientId)
          }
          emit({ type: 'end' })
          resolve()
        })
      })
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
  })
]

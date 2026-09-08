// src/relay/agent-rpc-dispatch-browser.ts
// browser.* RPC methods — split out of agent-rpc-dispatch.ts's giant switch
// to keep each file under the oxlint max-lines budget.
//
// TASK-036 option b: drives a real headless Chromium process launched ON
// THIS HOST (via the vendored `agent-browser` CLI), relayed from
// backend-go's wscompat/channels_browser.go. See browser-handler.ts's
// header comment for the session-scoping/idle-timeout/cleanup model —
// this is a genuinely new capability, not a port of the old
// Electron-local `browser.*` (backend/src/main/browser/agent-browser-bridge.ts).

import type WebSocket from 'ws'
import type { AgentLogger } from './agent-logger'
import type { WireState } from 'orca-dev-agent-transport'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from './agent-rpc-dispatch'
import { makeError, makeNotifier } from './agent-rpc-dispatch'

export async function dispatchBrowserRpc(
  rpc: JsonRpcRequest,
  log: AgentLogger,
  ws: WebSocket,
  state: WireState
): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    case 'browser.goto': {
      try {
        const { handleBrowserGoto } = await import('./browser-handler')
        return (await handleBrowserGoto(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.goto unavailable: ${msg}`)
      }
    }

    case 'browser.snapshot': {
      try {
        const { handleBrowserSnapshot } = await import('./browser-handler')
        return (await handleBrowserSnapshot(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.snapshot unavailable: ${msg}`)
      }
    }

    case 'browser.click': {
      try {
        const { handleBrowserClick } = await import('./browser-handler')
        return (await handleBrowserClick(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.click unavailable: ${msg}`)
      }
    }

    case 'browser.eval': {
      try {
        const { handleBrowserEval } = await import('./browser-handler')
        return (await handleBrowserEval(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.eval unavailable: ${msg}`)
      }
    }

    case 'browser.keypress': {
      try {
        const { handleBrowserKeypress } = await import('./browser-handler')
        return (await handleBrowserKeypress(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.keypress unavailable: ${msg}`)
      }
    }

    case 'browser.mouseMove': {
      try {
        const { handleBrowserMouseMove } = await import('./browser-handler')
        return (await handleBrowserMouseMove(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.mouseMove unavailable: ${msg}`
        )
      }
    }

    case 'browser.mouseDown': {
      try {
        const { handleBrowserMouseDown } = await import('./browser-handler')
        return (await handleBrowserMouseDown(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.mouseDown unavailable: ${msg}`
        )
      }
    }

    case 'browser.mouseUp': {
      try {
        const { handleBrowserMouseUp } = await import('./browser-handler')
        return (await handleBrowserMouseUp(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.mouseUp unavailable: ${msg}`)
      }
    }

    case 'browser.mouseWheel': {
      try {
        const { handleBrowserMouseWheel } = await import('./browser-handler')
        return (await handleBrowserMouseWheel(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.mouseWheel unavailable: ${msg}`
        )
      }
    }

    case 'browser.viewport': {
      try {
        const { handleBrowserViewport } = await import('./browser-handler')
        return (await handleBrowserViewport(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.viewport unavailable: ${msg}`)
      }
    }

    case 'browser.tabCreate': {
      try {
        const { handleBrowserTabCreate } = await import('./browser-handler')
        return (await handleBrowserTabCreate(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.tabCreate unavailable: ${msg}`
        )
      }
    }

    case 'browser.tabClose': {
      try {
        const { handleBrowserTabClose } = await import('./browser-handler')
        return (await handleBrowserTabClose(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `browser.tabClose unavailable: ${msg}`)
      }
    }

    // ── browser.screencast (live-view stream) ─────────────────────────────────
    // Why this passes makeNotifier(ws, state) (unlike the request/response
    // browser.* ops above): the CDP screencast session outlives this one
    // dispatch call, pushing browser.screencastReady/Frame/Ended/Error
    // notifications asynchronously for as long as it's attached — same
    // shape as the pty.* cases' notifier binding. See
    // browser-screencast-handler.ts's header comment for the full design.
    case 'browser.screencastStart': {
      try {
        const { handleBrowserScreencastStart } = await import('./browser-screencast-handler')
        return (await handleBrowserScreencastStart(
          rpc.id,
          rpc.params ?? {},
          log,
          makeNotifier(ws, state)
        )) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.screencastStart unavailable: ${msg}`
        )
      }
    }

    case 'browser.screencastStop': {
      try {
        const { handleBrowserScreencastStop } = await import('./browser-screencast-handler')
        return handleBrowserScreencastStop(
          rpc.id,
          rpc.params ?? {},
          makeNotifier(ws, state)
        ) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.screencastStop unavailable: ${msg}`
        )
      }
    }

    case 'browser.profileClearDefaultCookies': {
      try {
        const { handleBrowserProfileClearDefaultCookies } = await import('./browser-handler')
        return (await handleBrowserProfileClearDefaultCookies(
          rpc.id,
          rpc.params ?? {},
          log
        )) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.profileClearDefaultCookies unavailable: ${msg}`
        )
      }
    }

    case 'browser.profileDetectBrowsers': {
      try {
        const { handleBrowserProfileDetectBrowsers } = await import('./browser-handler')
        return (await handleBrowserProfileDetectBrowsers(
          rpc.id,
          rpc.params ?? {},
          log
        )) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `browser.profileDetectBrowsers unavailable: ${msg}`
        )
      }
    }

    default:
      return null
  }
}

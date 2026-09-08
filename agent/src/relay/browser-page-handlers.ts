// src/relay/browser-page-handlers.ts
// browser.* RPC handlers that drive one page/tab of a worktree's
// `agent-browser` session — navigation, input, viewport, and tab lifecycle.
//
// Split out of browser-handler.ts (which is now a re-export barrel) to stay
// under oxlint's max-lines budget. See browser-handler.ts's header comment
// for the session-scoping/idle-timeout/cleanup model these handlers rely on.

import type { AgentLogger } from './agent-logger'
import {
  dispatchBrowserCommand,
  makeFailure,
  makeSuccess,
  numberParam,
  optionalNumberParam,
  optionalStringParam,
  requireWorktreeId,
  runBrowserCommand,
  stringParam,
  type JsonRpcId,
  type JsonRpcResponse
} from './browser-command-runner'

// ─── browser.goto ────────────────────────────────────────────────────────────

export async function handleBrowserGoto(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'goto', () => ['open', stringParam(params, 'url')])
}

// ─── browser.snapshot ────────────────────────────────────────────────────────

export async function handleBrowserSnapshot(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'snapshot', () => ['snapshot'])
}

// ─── browser.click ───────────────────────────────────────────────────────────

export async function handleBrowserClick(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(
    id,
    params,
    log,
    'click',
    () => ['click', stringParam(params, 'element')],
    (data) => ({ clicked: (data as { clicked?: unknown } | null)?.clicked ?? params.element })
  )
}

// ─── browser.eval ────────────────────────────────────────────────────────────

export async function handleBrowserEval(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(
    id,
    params,
    log,
    'eval',
    () => ['eval', stringParam(params, 'expression')],
    (data) => ({ result: data })
  )
}

// ─── browser.keypress ────────────────────────────────────────────────────────

export async function handleBrowserKeypress(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'keypress', () => [
    'press',
    stringParam(params, 'key')
  ])
}

// ─── browser.mouseMove ───────────────────────────────────────────────────────

export async function handleBrowserMouseMove(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'mouseMove', () => [
    'mouse',
    'move',
    String(numberParam(params, 'x')),
    String(numberParam(params, 'y'))
  ])
}

// ─── browser.mouseDown ───────────────────────────────────────────────────────

export async function handleBrowserMouseDown(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'mouseDown', () => {
    const button = optionalStringParam(params, 'button')
    return button ? ['mouse', 'down', button] : ['mouse', 'down']
  })
}

// ─── browser.mouseUp ─────────────────────────────────────────────────────────

export async function handleBrowserMouseUp(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'mouseUp', () => {
    const button = optionalStringParam(params, 'button')
    return button ? ['mouse', 'up', button] : ['mouse', 'up']
  })
}

// ─── browser.mouseWheel ──────────────────────────────────────────────────────

export async function handleBrowserMouseWheel(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'mouseWheel', () => {
    const dy = numberParam(params, 'dy')
    const dx = optionalNumberParam(params, 'dx')
    return dx === undefined
      ? ['mouse', 'wheel', String(dy)]
      : ['mouse', 'wheel', String(dy), String(dx)]
  })
}

// ─── browser.viewport ────────────────────────────────────────────────────────

export async function handleBrowserViewport(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(id, params, log, 'viewport', () => [
    'set',
    'viewport',
    String(numberParam(params, 'width')),
    String(numberParam(params, 'height'))
  ])
}

// ─── browser.tabCreate ───────────────────────────────────────────────────────

export async function handleBrowserTabCreate(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(
    id,
    params,
    log,
    'tabCreate',
    () => ['tab', 'new'],
    (data) => {
      const tabData = data as { tabId?: unknown; url?: unknown } | null
      const tabId = typeof tabData?.tabId === 'string' ? tabData.tabId : undefined
      return { browserPageId: tabId, tabId, url: tabData?.url }
    }
  )
}

// ─── browser.tabClose ────────────────────────────────────────────────────────

/**
 * Closes one tab, then — per browser-handler.ts's documented session-cleanup
 * model — tears down the worktree's entire browser session if that was the
 * last tab, so closing a browser pane frees the host's headless Chrome
 * process immediately instead of waiting out the idle timeout.
 */
export async function handleBrowserTabClose(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    const worktreeId = requireWorktreeId(params)
    const tabId = optionalStringParam(params, 'page')
    const closeArgs = tabId ? ['tab', 'close', tabId] : ['tab', 'close']
    const closeData = await runBrowserCommand(worktreeId, closeArgs)

    let remainingTabs = 1
    try {
      const listData = (await runBrowserCommand(worktreeId, ['tab', 'list'])) as {
        tabs?: unknown[]
      } | null
      remainingTabs = Array.isArray(listData?.tabs) ? listData.tabs.length : 0
    } catch {
      // Why: if `tab list` fails right after the session's last tab closed,
      // treat it as "nothing left" — the safer default is tearing the
      // session down rather than leaking its Chrome process.
      remainingTabs = 0
    }

    if (remainingTabs === 0) {
      try {
        await runBrowserCommand(worktreeId, ['close'])
      } catch (err) {
        log.warn(
          `browser.tabClose: failed to tear down empty session ${worktreeId}: ${String(err)}`
        )
      }
    }

    return makeSuccess(id, closeData)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.tabClose failed: ${message}`)
    return makeFailure(id, message)
  }
}

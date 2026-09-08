/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalCreate,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
import { createPtyOutputProcessor } from './pty-transport'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  runtimeTerminalErrorMessage,
  toRemoteRuntimePtyId
} from '../../runtime/runtime-terminal-stream'
import {
  getRemoteRuntimeTerminalMultiplexer,
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE,
  type RemoteRuntimeMultiplexedTerminal,
  type RemoteRuntimeMultiplexedTerminalCallbacks
} from '../../runtime/remote-runtime-terminal-multiplexer'
import { subscribeTerminalViaJson } from '../../runtime/remote-runtime-terminal-json-subscribe'
import {
  toRuntimeTerminalWorktreeSelector,
  toRuntimeWorktreeSelector
} from '../../runtime/runtime-worktree-selector'
import {
  createRemoteRuntimePtyTextBatcher,
  createRemoteRuntimeViewportBatcher
} from './remote-runtime-pty-batching'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '@/runtime/web-terminal-surface-id'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 8
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000
// Why: terminal.create involves relay spawning a PTY process on the remote server.
// Cold-start (first terminal after server idle) can take up to 60 s.
const TERMINAL_CREATE_TIMEOUT_MS = 60_000
const DEFAULT_RUNTIME_TIMEOUT_MS = 15_000
// Why: retry terminal.create once on timeout/cold-start error before surfacing
// the error to the user. Relay may be warming up a fresh PTY worker.
const COLD_START_MAX_RETRIES = 1
const LONG_TIMEOUT_METHODS = new Set(['terminal.create', 'terminal.subscribe', 'terminal.attach'])

function isRemoteTerminalGoneMessage(message: string): boolean {
  return (
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_connected_pty')
  )
}

// Why: a silent WS reconnect (network blip, idle timeout, api-gateway
// restart/redeploy) mints a brand-new, empty per-connection terminal-stream
// registry backend-side (channels_terminal.go's own package doc comment) —
// this pane's still-alive ptyId then has no live AttachPty stream there
// anymore, and every terminal.send for it fails with this exact message
// forever, since nothing here ever re-issues terminal.create after a
// reconnect. Live-reproduced on b15.openledger.vn: a terminal that was
// already open and typing fine started rejecting every keystroke with this
// error the moment the underlying WS reconnected mid-session.
function isNoLiveAttachPtyStreamMessage(message: string): boolean {
  return message.includes('no live AttachPty stream')
}

// SOL-008 (specs/backend-go/bugs/missing-v3/): infra-fleet-service's
// SpawnTerminalSession returns this code when a runtime:<environmentId>
// target has no dev-server/SSH connection bound yet — a fixable
// precondition, not a bug. AppError.ToStatus() formats the gRPC status
// message as "<CODE>: <text>", so match on the code prefix rather than the
// full message (the message text itself is not a stable contract).
const NO_COMPUTE_BOUND_ERROR_CODE = 'INFRA_TERMINAL_NO_COMPUTE_BOUND'

function isNoComputeBoundMessage(message: string): boolean {
  return message.includes(NO_COMPUTE_BOUND_ERROR_CODE)
}

// FIX BUG-FE-PTY-001: a fresh local tab's connect() and its own host-session
// mirror tab can both mount for one leaf during the same reconcile churn (the
// mirror publishes before the local tab's terminal.create round-trip
// resolves). When connect() then finds itself destroyed(), it used to close
// the PTY it just spawned immediately — but that is the EXACT same PTY
// waitForHostSessionHandle's poll loop (150ms interval, up to 15s) is about
// to discover for the mirror, so this raced the mirror's every attach/resize
// into "PTY not found" (diagnosed live via ipc:devServerProxy trace logs and
// browser console transport create/destroy stacks). Give the mirror a short
// window to claim the handle via attachHostSessionMirror() below before
// actually closing it — a real cancelled launch just closes slightly later.
//
// Why 5000, not 2000 (live-prod regression found 2026-08-12): the mirror's
// own TerminalPane mount can itself be deferred up to GRACE_MOUNT_DEFER_MS
// (4000ms, terminal-pending-host-mirror-mount-gate.ts's fix #10) while
// waiting for the mirror tab to appear — attachHostSessionMirror()/
// claimGraceClose() below can't run until that component actually mounts.
// With the old 2000ms value, this grace-close could — and, confirmed via
// live backend logs, did — fire and destroy the PTY before mount-defer's
// worst case even finished waiting, reproducing the exact "not found" race
// this whole mechanism exists to prevent. Not imported from the mount-gate
// module to avoid a transport→UI-layer dependency; keep the two constants'
// relationship (this one > GRACE_MOUNT_DEFER_MS, with margin) in sync by
// hand if either changes.
const GRACE_CLOSE_DELAY_MS = 5_000
const pendingGraceCloses = new Map<string, { timer: ReturnType<typeof setTimeout> }>()

function scheduleGraceClose(handle: string, close: () => void): void {
  const existing = pendingGraceCloses.get(handle)
  if (existing) {
    clearTimeout(existing.timer)
  }
  const timer = setTimeout(() => {
    pendingGraceCloses.delete(handle)
    close()
  }, GRACE_CLOSE_DELAY_MS)
  pendingGraceCloses.set(handle, { timer })
}

/** Cancels a scheduled grace-close when a mirror successfully claims the same
 *  handle. Returns true if a pending close was actually cancelled. */
function claimGraceClose(handle: string): boolean {
  const pending = pendingGraceCloses.get(handle)
  if (!pending) {
    return false
  }
  clearTimeout(pending.timer)
  pendingGraceCloses.delete(handle)
  return true
}

/**
 * PTY transport backing a renderer terminal pane with a terminal on a remote Orca
 * runtime, over runtime RPC plus the multiplexed stream (create, subscribe, input,
 * resize, close, reattach).
 */
export function createRemoteRuntimePtyTransport(
  runtimeEnvironmentId: string,
  opts: IpcPtyTransportOptions = {}
): PtyTransport {
  const {
    command,
    startupCommandDelivery,
    env,
    launchConfig,
    launchToken,
    launchAgent,
    connectionId,
    worktreeId,
    tabId,
    leafId,
    activate,
    onPtyExit,
    onPtySpawn,
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus,
    onColdStartBegin,
    onColdStartRetry,
    onColdStartComplete,
    onColdStartFailed
  } = opts
  let connected = false
  let destroyed = false
  let handle: string | null = null
  let remotePtyId: string | null = null
  let currentRuntimeEnvironmentId = runtimeEnvironmentId
  let multiplexedStream: RemoteRuntimeMultiplexedTerminal | null = null
  let multiplexedStreamHandle: string | null = null
  let desiredViewport: { cols: number; rows: number } | null = null
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  let resubscribing = false
  let resubscribeRequested = false
  let subscriptionGeneration = 0
  let pendingViewportClaim = false
  let pendingClaimInput = ''
  const viewportClaimReadyWaiters = new Set<(ready: boolean) => void>()
  const clearPendingViewportClaim = (): void => {
    pendingViewportClaim = false
    pendingClaimInput = ''
    for (const resolve of viewportClaimReadyWaiters) {
      resolve(false)
    }
    viewportClaimReadyWaiters.clear()
  }
  // Why: tab/leaf ids identify the mirrored host pane, so every paired viewer
  // shares them. The instance suffix keeps one viewer's refresh off peer records.
  const clientId = `desktop:${tabId ?? 'tab'}:${leafId ?? 'leaf'}:${createBrowserUuid()}`
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })

  function findReadyHostSessionHandle(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): string | null {
    const terminalTabs = getHostSessionTerminalSurfaces(snapshot, hostTabId, {
      matchRequestedLeaf: false
    })
    if (leafId) {
      const requestedLeaf = terminalTabs.find(
        (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.leafId === leafId
      )
      return requestedLeaf?.terminal ?? null
    }
    const preferred =
      terminalTabs.find(
        (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.isActive
      ) ?? terminalTabs.find((tab) => tab.status === 'ready' && tab.parentTabId === hostTabId)
    return preferred?.terminal ?? null
  }

  function getHostSessionTerminalSurfaces(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string,
    options: { matchRequestedLeaf: boolean }
  ): RuntimeMobileSessionTerminalClientTab[] {
    return snapshot.tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalClientTab =>
        tab.type === 'terminal' &&
        (tab.parentTabId === hostTabId || tab.id === hostTabId) &&
        (!options.matchRequestedLeaf || !leafId || tab.leafId === leafId)
    )
  }

  function hasHostSessionTerminalSurface(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): boolean {
    return (
      getHostSessionTerminalSurfaces(snapshot, hostTabId, {
        matchRequestedLeaf: true
      }).length > 0
    )
  }

  async function waitForHostSessionHandle(hostTabId: string): Promise<string | null> {
    if (!worktreeId) {
      return null
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    const activated = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.activate', {
      worktree,
      tabId: hostTabId,
      ...(leafId ? { leafId } : {})
    })
    const immediate = findReadyHostSessionHandle(activated, hostTabId)
    if (immediate) {
      return immediate
    }

    const startedAt = Date.now()
    while (!destroyed) {
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return null
      }
      // Why: host mirrors can be published before their PTY handle is ready,
      // but a stuck pending surface must not poll the runtime forever.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(HOST_SESSION_ATTACH_POLL_MS, remainingMs))
      )
      const listed = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
        worktree
      })
      const handle = findReadyHostSessionHandle(listed, hostTabId)
      if (handle) {
        return handle
      }
      if (!hasHostSessionTerminalSurface(listed, hostTabId)) {
        return null
      }
    }
    return null
  }

  async function listHostSessionHandle(hostTabId: string): Promise<string | null> {
    if (!worktreeId) {
      return null
    }
    const listed = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: toRuntimeWorktreeSelector(worktreeId)
    })
    return findReadyHostSessionHandle(listed, hostTabId)
  }

  async function attachHostSessionMirror(
    options: Parameters<PtyTransport['connect']>[0]
  ): Promise<PtyConnectResult | undefined> {
    if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
      return undefined
    }
    const hostTabId = toHostSessionTabId(tabId)
    const hostHandle = await waitForHostSessionHandle(hostTabId)
    if (!hostHandle || destroyed) {
      if (!destroyed) {
        storedCallbacks.onError?.('Remote terminal was closed.')
      }
      return undefined
    }

    // FIX BUG-FE-PTY-001: this handle may be the exact PTY a sibling local
    // tab's now-superseded connect() just spawned and is about to grace-close
    // — claim it before that timer fires so we don't attach to (or race) a
    // PTY that's being torn down underneath us.
    claimGraceClose(hostHandle)
    handle = hostHandle
    remotePtyId = toRemoteRuntimePtyId(hostHandle, currentRuntimeEnvironmentId)
    connected = true
    desiredViewport = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    }
    onPtySpawn?.(remotePtyId)

    await subscribeToHandle()
    if (destroyed || !connected || !remotePtyId) {
      return undefined
    }

    return {
      id: remotePtyId,
      replay: ''
    } satisfies PtyConnectResult
  }

  async function callRuntime<TResult>(method: string, params?: unknown): Promise<TResult> {
    const timeoutMs = LONG_TIMEOUT_METHODS.has(method)
      ? TERMINAL_CREATE_TIMEOUT_MS
      : DEFAULT_RUNTIME_TIMEOUT_MS
    const response = await window.api.runtimeEnvironments.call({
      selector: currentRuntimeEnvironmentId,
      method,
      params,
      timeoutMs
    })
    return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>)
  }

  /**
   * TM-001-B: callRuntime with retry for cold-start scenarios.
   * Only retries terminal.create (the method that times out on cold servers).
   * Fires onColdStart* callbacks so UI can show a loading overlay.
   */
  async function callRuntimeWithColdStartRetry<TResult>(
    method: string,
    params?: unknown
  ): Promise<TResult> {
    let lastError: unknown
    for (let attempt = 0; attempt <= COLD_START_MAX_RETRIES; attempt++) {
      if (attempt === 0) {
        onColdStartBegin?.()
      } else {
        onColdStartRetry?.(attempt)
      }
      try {
        const result = await callRuntime<TResult>(method, params)
        onColdStartComplete?.()
        return result
      } catch (err: unknown) {
        lastError = err
        const msg = err instanceof Error ? err.message : String(err)
        // Why 'agent not connected' is retryable: this specific message means
        // the Dev Server's agent WS to Orca is mid-reconnect — a normal,
        // self-healing ~1-2s network blip (see agent-connection-direct.ts's
        // proactive-renew-on-drop fix), not a real outage. A request that
        // happens to land in that narrow gap shouldn't surface a scary error
        // for something that resolves itself a moment later.
        const isAgentReconnectRace = msg.includes('agent not connected')
        const isRetryable =
          msg.includes('timed out') ||
          msg.includes('timeout') ||
          msg.includes('relay_starting') ||
          msg.includes('worker_cold') ||
          isAgentReconnectRace
        if (!isRetryable || attempt >= COLD_START_MAX_RETRIES) {
          break
        }
        if (isAgentReconnectRace) {
          // Why a fixed delay instead of retrying immediately: an instant
          // retry would almost certainly land in the same still-reconnecting
          // gap. Tonight's observed reconnect times were ~1.1-2.3s.
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }
    onColdStartFailed?.()
    throw lastError
  }

  async function closeRemoteTerminal(handleOverride?: string): Promise<void> {
    const targetHandle = handleOverride ?? handle
    if (!targetHandle) {
      return
    }
    try {
      await callRuntime('terminal.close', { terminal: targetHandle })
    } catch {
      // Best-effort parity with local disconnect/kill.
    }
  }

  async function sendInputAcceptedToRuntime(data: string): Promise<boolean> {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return false
    }
    if (!data) {
      return true
    }
    await inputBatcher.drain()
    if (!connected || handle !== targetHandle) {
      return false
    }
    if (pendingViewportClaim && !getCurrentMultiplexedStream(targetHandle)) {
      const ready = await new Promise<boolean>((resolve) => {
        viewportClaimReadyWaiters.add(resolve)
      })
      if (!ready || !connected || handle !== targetHandle) {
        return false
      }
    }
    // Why: normal remote sendInput may be waiting on yielded size validation;
    // drain it before acknowledged writes so terminal bytes stay ordered.
    const text = `${inputBatcher.takePending()}${data}`
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(text)
      if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
        return false
      }
    } catch {
      return false
    }
    try {
      for (const chunk of iterateTerminalInputChunks(text)) {
        if (!connected || handle !== targetHandle) {
          return false
        }
        // Why: acknowledged sends are ordered behind any pending debounce text,
        // but they must not collapse large paste input back into one remote RPC.
        const result = await sendTerminalSendAckWithReattachRetry(targetHandle, chunk)
        if (result.send.accepted !== true) {
          return false
        }
      }
      return true
    } catch (error) {
      // Why: stale-handle errors must retire the mirror (recoverable via the
      // next snapshot) rather than dead-end in a red xterm banner (#7718).
      handleRemoteTerminalError(error)
      return false
    }
  }

  // Why a separate typed sibling of sendTerminalTextWithReattachRetry: this
  // caller needs terminal.send's real {send:{accepted}} ack (Enter/Ctrl-C
  // must know whether the write was actually accepted), not the fire-and-
  // forget void the plain-typing paths use. See
  // isNoLiveAttachPtyStreamMessage's doc comment for why the reattach retry
  // exists at all.
  async function sendTerminalSendAckWithReattachRetry(
    targetHandle: string,
    text: string
  ): Promise<{ send: RuntimeTerminalSend }> {
    try {
      return await callRuntime<{ send: RuntimeTerminalSend }>(
        'terminal.send',
        buildTerminalSendPayload(targetHandle, text)
      )
    } catch (error) {
      if (!isNoLiveAttachPtyStreamMessage(runtimeTerminalErrorMessage(error))) {
        throw error
      }
      await callRuntime('terminal.reattachSend', { terminal: targetHandle })
      return callRuntime<{ send: RuntimeTerminalSend }>(
        'terminal.send',
        buildTerminalSendPayload(targetHandle, text)
      )
    }
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(REMOTE_TERMINAL_INPUT_FLUSH_MS, (text) => {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (stream?.sendInput(text)) {
      return
    }
    // Why !getCurrentMultiplexedStream(targetHandle): pendingViewportClaim
    // alone is not a safe hold condition — the JSON/session-auth fallback
    // transport (remote-runtime-terminal-json-subscribe.ts) has a permanent
    // stream record whose sendInput/claimViewport are deliberate no-op stubs
    // (that transport has no persistent input channel; callers always fall
    // back to terminal.send below), so its first claim-resize latches
    // pendingViewportClaim true forever — it only clears on an actual
    // resubscribe, which this transport's single generation-1 session never
    // hits. Without this guard, every keystroke silently queues into
    // pendingClaimInput and never reaches terminal.send — live-reproduced:
    // a fresh b15.openledger.vn terminal that opens fine but accepts no
    // typed input. Mirrors sendInputAcceptedToRuntime's existing, correct
    // guard (only hold input while truly no stream record exists yet).
    if (pendingViewportClaim && !getCurrentMultiplexedStream(targetHandle)) {
      // Why: a claim during subscribe/reconnect has no stream record to own
      // yet. Hold its input until the stream can emit claim+input in one order.
      pendingClaimInput += text
      return
    }
    void sendTerminalTextWithReattachRetry(targetHandle, text)
  })

  function sendViewportUpdate(cols: number, rows: number, claim = false): void {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (claim ? stream?.claimViewport(cols, rows) : stream?.resize(cols, rows)) {
      if (claim) {
        pendingViewportClaim = false
      }
      return
    }
    if (claim) {
      pendingViewportClaim = true
    }
    void callRuntime('terminal.updateViewport', {
      terminal: targetHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: { cols, rows },
      ...(claim ? { claim: true } : {})
    }).catch(() => {})
  }

  const viewportBatcher = createRemoteRuntimeViewportBatcher(
    REMOTE_TERMINAL_VIEWPORT_FLUSH_MS,
    sendViewportUpdate
  )

  function rememberViewport(cols: number, rows: number): void {
    desiredViewport = { cols, rows }
  }

  function getCurrentMultiplexedStream(
    targetHandle: string
  ): RemoteRuntimeMultiplexedTerminal | null {
    return multiplexedStreamHandle === targetHandle ? multiplexedStream : null
  }

  function closeMultiplexedStream(): void {
    multiplexedStream?.close()
    multiplexedStream = null
    multiplexedStreamHandle = null
  }

  function isCurrentRemoteTerminal(targetHandle: string, targetPtyId: string | null): boolean {
    return (
      !destroyed &&
      connected &&
      handle === targetHandle &&
      remotePtyId === targetPtyId &&
      targetPtyId !== null
    )
  }

  function retireRemoteTerminalId(): void {
    connected = false
    clearPendingViewportClaim()
    const stalePtyId = remotePtyId
    handle = null
    remotePtyId = null
    closeMultiplexedStream()
    if (stalePtyId) {
      onPtyExit?.(stalePtyId)
    }
  }

  function handleRemoteTerminalError(error: unknown): void {
    const message = runtimeTerminalErrorMessage(error)
    if (message === REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE) {
      // Why: an oversized initial snapshot is skipped but live output keeps
      // flowing — informational, not fatal, so never surface a red xterm banner.
      return
    }
    if (isRemoteTerminalGoneMessage(message)) {
      // Why: paired web clients consume host-published PTY handles. If the host
      // retires one between snapshots, clear this mirror and wait for the next
      // session-tabs update instead of surfacing a red xterm error.
      retireRemoteTerminalId()
      return
    }
    storedCallbacks.onError?.(message)
  }

  function buildTerminalSendPayload(targetHandle: string, text: string): Record<string, unknown> {
    return {
      terminal: targetHandle,
      text,
      client: { id: clientId, type: 'desktop' },
      ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
    }
  }

  // Why a reattach-then-retry wrapper, not just calling terminal.send
  // directly: see isNoLiveAttachPtyStreamMessage's doc comment — a silent WS
  // reconnect leaves this pane's ptyId with no live backend-side AttachPty
  // stream, and terminal.send alone can never recover from that (nothing
  // re-issues terminal.create after a reconnect). terminal.reattachSend
  // re-registers the SAME still-alive pty (it does not spawn a new one,
  // unlike terminal.create), so a single retry after it succeeds is enough;
  // any other error, or a reattach/retry failure, still falls through to
  // the normal error handling.
  async function sendTerminalTextWithReattachRetry(
    targetHandle: string,
    text: string
  ): Promise<void> {
    try {
      await callRuntime('terminal.send', buildTerminalSendPayload(targetHandle, text))
    } catch (error) {
      if (!isNoLiveAttachPtyStreamMessage(runtimeTerminalErrorMessage(error))) {
        handleRemoteTerminalError(error)
        return
      }
      try {
        await callRuntime('terminal.reattachSend', { terminal: targetHandle })
        await callRuntime('terminal.send', buildTerminalSendPayload(targetHandle, text))
      } catch (retryError) {
        handleRemoteTerminalError(retryError)
      }
    }
  }

  // Why: after a transport drop the host may have re-minted this pane's
  // handle (reconnect, epoch or PTY change). Re-derive it from the current
  // session snapshot instead of resubscribing the stale closure value, which
  // would mirror (and type into) whatever PTY now sits behind it (#7718).
  async function resubscribeAfterTransportClose(previousHandle: string): Promise<void> {
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      const nextHandle = await listHostSessionHandle(toHostSessionTabId(tabId))
      if (destroyed || !connected || handle !== previousHandle) {
        return
      }
      if (!nextHandle) {
        // Why: the host no longer publishes this surface; retire quietly and
        // let the next session-tabs snapshot drive respawn/removal.
        retireRemoteTerminalId()
        return
      }
      if (nextHandle !== previousHandle) {
        handle = nextHandle
        remotePtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
        onPtySpawn?.(remotePtyId)
      }
    }
    await subscribeToHandle()
  }

  function scheduleResubscribeAfterTransportClose(): void {
    if (destroyed || !connected || !handle) {
      return
    }
    if (resubscribing) {
      resubscribeRequested = true
      return
    }
    resubscribing = true
    const resubscribeHandle = handle
    void resubscribeAfterTransportClose(resubscribeHandle)
      .catch((error) => {
        if (!destroyed && connected && handle) {
          clearPendingViewportClaim()
          handleRemoteTerminalError(error)
        }
      })
      .finally(() => {
        resubscribing = false
        if (resubscribeRequested) {
          resubscribeRequested = false
          scheduleResubscribeAfterTransportClose()
        }
      })
  }

  async function subscribeToHandle(): Promise<void> {
    if (!handle) {
      return
    }
    const subscribedHandle = handle
    const subscribedPtyId = remotePtyId
    const generation = ++subscriptionGeneration
    let transportClosed = false
    // Why: the viewport we hand the subscribe request. A resize landing during
    // the round-trip falls back to the one-shot RPC, which is refresh-only (no
    // leak) and no-ops before the stream record exists — so replay the latest
    // remembered viewport through the stream once it's current (below).
    const subscribedViewport = desiredViewport
    const isCurrentSubscription = (): boolean =>
      !transportClosed &&
      generation === subscriptionGeneration &&
      isCurrentRemoteTerminal(subscribedHandle, subscribedPtyId)
    const subscribeCallbacks: RemoteRuntimeMultiplexedTerminalCallbacks = {
      onData: (data, meta) => {
        if (isCurrentSubscription()) {
          outputProcessor.processData(data, storedCallbacks, undefined, meta)
        }
      },
      onSnapshot: (data, meta) => {
        // Why: a snapshot with no body can still carry a pending mid-escape
        // tail that must be replayed so the next live chunk completes it.
        if ((data || meta?.pendingEscapeTailAnsi) && isCurrentSubscription()) {
          outputProcessor.processData(data, storedCallbacks, {
            replayingBufferedData: true,
            suppressAttentionEvents: true,
            ...(meta?.pendingEscapeTailAnsi
              ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi }
              : {})
          })
        }
      },
      onSubscribed: () => {
        if (!isCurrentSubscription()) {
          return
        }
        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')
      },
      onEnd: () => {
        if (!isCurrentSubscription()) {
          return
        }
        outputProcessor.clearAccumulatedState()
        connected = false
        handle = null
        remotePtyId = null
        multiplexedStream = null
        multiplexedStreamHandle = null
        clearPendingViewportClaim()
        storedCallbacks.onExit?.(0)
        storedCallbacks.onDisconnect?.()
        if (subscribedPtyId) {
          onPtyExit?.(subscribedPtyId)
        }
      },
      onError: (message) => {
        if (isCurrentSubscription()) {
          handleRemoteTerminalError(message)
        }
      },
      onFitOverrideChanged: (event) => {
        if (isCurrentSubscription() && subscribedPtyId) {
          setFitOverride(subscribedPtyId, event.mode, event.cols, event.rows)
        }
      },
      onDriverChanged: (driver) => {
        if (isCurrentSubscription() && subscribedPtyId) {
          setDriverForPty(subscribedPtyId, driver)
        }
      },
      onTransportClose: () => {
        transportClosed = true
        if (generation !== subscriptionGeneration) {
          return
        }
        if (!isCurrentSubscription()) {
          // isCurrentSubscription excludes the just-closed stream by design.
          if (!isCurrentRemoteTerminal(subscribedHandle, subscribedPtyId)) {
            return
          }
        }
        multiplexedStream = null
        multiplexedStreamHandle = null
        scheduleResubscribeAfterTransportClose()
      }
    }
    const subscribeArgs = {
      terminal: subscribedHandle,
      client: { id: clientId, type: 'desktop' as const },
      viewport: subscribedViewport ?? undefined,
      callbacks: subscribeCallbacks
    }
    // Why: 'session-auth' (backend-go's WebSessionClient) genuinely cannot
    // carry binary WS frames — confirmed by reading the client itself:
    // handleSocketMessage's `if (typeof rawData !== 'string') return` drops
    // every binary frame outright, and subscribe()'s returned sendBinary
    // unconditionally throws ("Binary frames not supported in session mode
    // over this channel"). An earlier pass here assumed WebSessionClient
    // supported binary because the TS interface declares sendBinary/onBinary
    // (satisfying RemoteRuntimeMultiplexedTerminalCallbacks structurally) —
    // wrong; those fields exist only to satisfy the type, the implementation
    // stubs them. terminal.multiplex is for WebRuntimeClient (paired/E2EE)
    // only. 'session-auth' must use the plain-JSON fallback — which needs
    // backend-go to actually implement terminal.subscribe/unsubscribe (see
    // channels_terminal_subscribe.go) — found live 2026-08-30 via direct WS
    // frame capture (script-based, not a screenshot): confirmed the create
    // RPC, the multiplex RPC ack, and the initial prompt all succeed, but
    // zero binary frames ever cross the wire and every later terminal.* RPC
    // silently no-ops or 404s.
    const nextStream =
      currentRuntimeEnvironmentId === 'session-auth'
        ? await subscribeTerminalViaJson({
            environmentId: currentRuntimeEnvironmentId,
            ...subscribeArgs
          })
        : await getRemoteRuntimeTerminalMultiplexer(currentRuntimeEnvironmentId).subscribeTerminal(
            subscribeArgs
          )
    if (
      transportClosed ||
      generation !== subscriptionGeneration ||
      destroyed ||
      !connected ||
      handle !== subscribedHandle ||
      remotePtyId !== subscribedPtyId
    ) {
      nextStream.close()
      return
    }
    closeMultiplexedStream()
    multiplexedStream = nextStream
    multiplexedStreamHandle = subscribedHandle
    // Why: a viewport change that landed during the subscribe round-trip took
    // the now-no-op one-shot fallback, so the stream record is still at the
    // subscribe-time size. Replay the latest remembered viewport so the PTY
    // tracks the current width instead of stalling until the next resize.
    if (pendingViewportClaim && desiredViewport) {
      nextStream.claimViewport(desiredViewport.cols, desiredViewport.rows)
      pendingViewportClaim = false
      const queuedInput = pendingClaimInput
      pendingClaimInput = ''
      // Why the terminal.send fallback: nextStream.sendInput can legitimately
      // be a permanent no-op (the JSON/session-auth fallback transport, see
      // this file's other pendingViewportClaim guard comment) — input queued
      // during the brief pre-subscribe window must still reach the wire.
      if (queuedInput && !nextStream.sendInput(queuedInput)) {
        void sendTerminalTextWithReattachRetry(subscribedHandle, queuedInput)
      }
      for (const resolve of viewportClaimReadyWaiters) {
        resolve(true)
      }
      viewportClaimReadyWaiters.clear()
    } else if (
      desiredViewport &&
      (desiredViewport.cols !== subscribedViewport?.cols ||
        desiredViewport.rows !== subscribedViewport?.rows)
    ) {
      nextStream.resize(desiredViewport.cols, desiredViewport.rows)
    }
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      if (destroyed || !worktreeId) {
        return
      }

      try {
        if (isWebTerminalSurfaceTabId(tabId ?? '')) {
          return await attachHostSessionMirror(options)
        }

        const commandToSend = options.command ?? command
        const startupCommandDeliveryToSend =
          options.startupCommandDelivery ?? startupCommandDelivery
        const envToSend = options.env ?? env
        const launchConfigToSend = options.launchConfig ?? launchConfig
        const launchTokenToSend = options.launchToken ?? launchToken
        const launchAgentToSend = options.launchAgent ?? launchAgent
        // TM-001-B: Use retry-aware helper for terminal.create (cold-start resilience)
        const created = await callRuntimeWithColdStartRetry<{ terminal: RuntimeTerminalCreate }>(
          'terminal.create',
          {
            worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
            // Why: backend-go's terminal.create (channels_terminal.go) only
            // reads connectionId, never worktree — SpawnTerminalSession takes
            // an empty ConnectionID as "spawn a host-local PTY", which the
            // web deployment cannot do (INFRA_TERMINAL_NO_COMPUTE_BOUND,
            // found live 2026-08-30; see isNoComputeBoundMessage above).
            // Every dev-server-bound terminal on web rides this transport, so
            // connectionId must travel with it.
            ...(connectionId ? { connectionId } : {}),
            ...(commandToSend !== undefined ? { command: commandToSend } : {}),
            ...(startupCommandDeliveryToSend !== undefined
              ? { startupCommandDelivery: startupCommandDeliveryToSend }
              : {}),
            ...(envToSend !== undefined ? { env: envToSend } : {}),
            ...(launchConfigToSend !== undefined ? { launchConfig: launchConfigToSend } : {}),
            ...(launchTokenToSend !== undefined ? { launchToken: launchTokenToSend } : {}),
            ...(launchAgentToSend !== undefined ? { launchAgent: launchAgentToSend } : {}),
            tabId,
            leafId,
            focus: false,
            // Why: this transport is backing an already-mounted renderer pane;
            // activation here is local state, not permission for remote UI reveal.
            presentation: 'background',
            ...(activate === true ? { activate: true } : {})
          }
        )
        handle = created.terminal.handle
        if (destroyed) {
          // FIX BUG-FE-PTY-001: this is USUALLY a cancelled launch (rapid
          // tab-open/tab-close) — close the server PTY so it doesn't leak.
          // But it's also exactly what happens when this same leaf's own
          // host-session mirror tab mounted and superseded this one before
          // terminal.create finished: that mirror's attachHostSessionMirror
          // is polling for THIS exact PTY (waitForHostSessionHandle). Give it
          // GRACE_CLOSE_DELAY_MS to claim the handle before actually closing.
          scheduleGraceClose(created.terminal.handle, () => {
            void closeRemoteTerminal(created.terminal.handle)
          })
          return
        }

        remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
        connected = true
        desiredViewport = {
          cols: options.cols ?? 80,
          rows: options.rows ?? 24
        }
        onPtySpawn?.(remotePtyId)

        await subscribeToHandle()
        if (destroyed || !connected || !remotePtyId) {
          return
        }

        return {
          id: remotePtyId,
          replay: ''
        } satisfies PtyConnectResult
      } catch (error) {
        const message = runtimeTerminalErrorMessage(error)
        if (isNoComputeBoundMessage(message)) {
          storedCallbacks.onError?.(
            'This environment has no compute attached — attach a dev server or SSH connection to this environment before opening a terminal.'
          )
        } else {
          storedCallbacks.onError?.(message)
        }
        return undefined
      }
    },

    attach(options) {
      storedCallbacks = options.callbacks
      currentRuntimeEnvironmentId =
        getRemoteRuntimePtyEnvironmentId(options.existingPtyId) ?? runtimeEnvironmentId
      const previousHandle = handle
      const nextHandle = getRemoteRuntimeTerminalHandle(options.existingPtyId)
      if (previousHandle && previousHandle !== nextHandle) {
        // Why: debounced input is scoped by the current terminal handle at flush time.
        inputBatcher.clear()
      }
      // FIX BUG-FE-PTY-001 (#13): connectPanePty (pty-connection.ts) prefers
      // this ATTACH path over connect() whenever a leaf already has a known
      // remote PTY id (the common case for a host-mirrored leaf whose
      // sibling local tab just spawned it) -- but only connect()'s
      // attachHostSessionMirror() ever called claimGraceClose(). A mirror
      // that attaches here to a handle its sibling's connect() just
      // scheduleGraceClose()'d never cancels that timer, so
      // GRACE_CLOSE_DELAY_MS later the PTY gets closed out from under an
      // actively-attached pane (live repro: transport attaches successfully,
      // then gets torn down ~5s later with no user action). Claim it here
      // too, mirroring attachHostSessionMirror()'s call at the same point.
      if (nextHandle) {
        claimGraceClose(nextHandle)
      }
      handle = nextHandle
      if (!handle) {
        connected = false
        remotePtyId = null
        closeMultiplexedStream()
        storedCallbacks.onError?.('Remote runtime terminal id is invalid.')
        return
      }
      // Why: legacy restored ids omitted their runtime owner. Canonicalize at
      // attach so renderer stores and lifecycle guards never share raw aliases.
      remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      const targetHandle = handle
      const targetPtyId = remotePtyId
      void subscribeToHandle().catch((error) => {
        if (!isCurrentRemoteTerminal(targetHandle, targetPtyId)) {
          return
        }
        if (handle === targetHandle && multiplexedStreamHandle !== targetHandle) {
          closeMultiplexedStream()
        }
        clearPendingViewportClaim()
        handleRemoteTerminalError(error)
      })
    },

    disconnect() {
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      if (!connected && !handle) {
        return
      }
      connected = false
      clearPendingViewportClaim()
      const id = remotePtyId
      // TM-002-A: Serialize terminal buffer before closing the multiplexed stream
      // so snapshot data is still accessible. Fire-and-forget via terminalSessions
      // preload IPC (non-fatal if it fails).
      if (id && worktreeId && tabId) {
        const stream = multiplexedStream
        if (stream) {
          stream
            .serializeBuffer?.({ scrollbackRows: 1000 })
            .then((snap) => {
              if (snap && worktreeId && tabId) {
                void window.api.terminalSessions?.save?.({
                  worktreeId,
                  tabId,
                  leafId: leafId ?? undefined,
                  snapshotData: snap.data,
                  snapshotCols: snap.cols,
                  snapshotRows: snap.rows
                })
              }
            })
            .catch(() => {
              /* Non-fatal snapshot save */
            })
        }
      }
      closeMultiplexedStream()
      handle = null
      remotePtyId = null
      storedCallbacks.onDisconnect?.()
      if (id) {
        onPtyExit?.(id)
      }
    },

    detach() {
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      connected = false
      clearPendingViewportClaim()
      closeMultiplexedStream()
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !handle) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: callers use \r or terminal.send's enter flag for semantic Enter;
      // literal LF bytes from paste/programmatic input must survive the stream.
      return inputBatcher.push(data)
    },

    // Why: terminal query replies (CPR/DSR/DA/OSC color/pixel size) are read by
    // the querying program in raw mode with a short timeout. The 8ms input
    // debounce makes the reply miss that window, so it lands on the shell prompt
    // and is echoed literally / spliced into typed input (#7329). Flush any
    // pending batched input first so byte order is preserved, then send the
    // reply immediately without arming the debounce timer.
    sendInputImmediate(data: string): boolean {
      const targetHandle = handle
      if (!connected || !targetHandle) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: earlier input (e.g. a large paste) may still be in async byte-length
      // validation, so it is captured in the batcher's validationTail and NOT in
      // takePending(). Bypassing the queue here would send the reply ahead of it
      // and reorder bytes on the wire. In that rare window, route the reply
      // through the batcher's ordered queue and flush what is already validated;
      // the reply lands right after the pending input once its validation
      // resolves. Order correctness beats the immediacy that the debounce
      // normally trades away.
      if (inputBatcher.hasPendingValidation()) {
        const accepted = inputBatcher.push(data)
        inputBatcher.flush()
        return accepted
      }
      const pending = inputBatcher.takePending()
      const text = `${pending}${data}`
      const stream = getCurrentMultiplexedStream(targetHandle)
      if (stream?.sendInput(text)) {
        return true
      }
      // Why !getCurrentMultiplexedStream(targetHandle): same fix as the
      // inputBatcher flush callback above — see its comment for the full
      // reasoning (stuck pendingViewportClaim latch on the JSON/session-auth
      // fallback transport).
      if (pendingViewportClaim && !getCurrentMultiplexedStream(targetHandle)) {
        pendingClaimInput += text
        return true
      }
      void sendTerminalTextWithReattachRetry(targetHandle, text)
      return true
    },

    sendInputAccepted: sendInputAcceptedToRuntime,

    claimViewport(cols: number, rows: number): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      viewportBatcher.clear()
      sendViewportUpdate(cols, rows, true)
      return true
    },

    resize(cols: number, rows: number, meta): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (meta?.claim) {
        viewportBatcher.clear()
        sendViewportUpdate(cols, rows, true)
        return true
      }
      // Why: xterm fit can emit resize bursts while the user drags panes or
      // restores layouts. Remote runtimes only need the last viewport in a frame.
      viewportBatcher.queue(cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    getPtyId() {
      return remotePtyId
    },

    getConnectionId() {
      return connectionId ?? null
    },

    getRuntimeEnvironmentId() {
      return currentRuntimeEnvironmentId
    },

    async serializeBuffer(opts) {
      if (!connected || !handle) {
        return null
      }
      return getCurrentMultiplexedStream(handle)?.serializeBuffer(opts) ?? null
    },

    destroy() {
      destroyed = true
      this.disconnect()
      inputBatcher.clear()
      viewportBatcher.clear()
    }
  }
}

import { createTerminalOutputBatcher } from './terminal-output-batcher'
import type { TerminalOutputBatcher } from './terminal-output-batcher'
import { isTerminalReadPayloadIncomplete } from './terminal-stream-replay'
import { serializeBudgetedMobileSnapshot } from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import { watchSubscriptionLifetime } from './terminal-input-delivery'
import type { TerminalSubscriptionArgs } from './terminal-legacy-subscription-types'
import { allocateTerminalSubscriptionStreamId } from './terminal-subscription-stream-id'

export async function runTerminalLeaseSubscription(args: TerminalSubscriptionArgs): Promise<void> {
  const { params, runtime, connectionId, signal, emit, ptyId, clientId } = args
  if (!clientId) {
    return
  }
  let closed = false
  let stopWatchingLifetime = (): void => {}
  let resolveStream = (): void => {}
  const streamClosed = new Promise<void>((resolve) => {
    resolveStream = resolve
  })
  const subscriptionId = `${params.terminal}:${clientId}`
  // Why: chat needs the input-floor ack without registering a view subscriber or transporting duplicate PTY output.
  const registration = runtime.registerOwnedSubscriptionCleanup(
    subscriptionId,
    () => {
      stopWatchingLifetime()
      closed = true
      runtime.handleMobileUnsubscribe(ptyId, clientId)
      emit({ type: 'end' })
      resolveStream()
    },
    connectionId
  )
  stopWatchingLifetime = watchSubscriptionLifetime(runtime, ptyId, signal, registration)
  if (closed) {
    // Why: an already-exited pty releases synchronously, so cleanup ran before this setup registers anything.
    return
  }
  try {
    // Why: a lease-only subscriber has no terminal view, so its cached viewport must never phone-fit the PTY.
    await runtime.handleMobileSubscribe(ptyId, clientId, undefined)
    if (closed || signal?.aborted) {
      // Why: a disconnect can win the awaited subscribe and resurrect mobile presence after cleanup already released it.
      // Unguarded on purpose: this must still fire when our own cleanup already ran.
      // Safe only because lease-only passes no viewport and both !viewport paths in
      // handleMobileSubscribeInternal return with no await, so no rebind can land
      // first. Adding an await there — or passing a viewport here — makes a
      // superseded handler delete the replacement's (ptyId, clientId) presence.
      runtime.handleMobileUnsubscribe(ptyId, clientId)
      if (!closed) {
        registration.releaseIfCurrent()
      }
      return
    }
    emit({ type: 'subscribed', streamId: null, lines: [], truncated: false })
    await streamClosed
  } catch (error) {
    registration.releaseIfCurrent()
    throw error
  }
}

export async function runTerminalJsonSubscription(args: TerminalSubscriptionArgs): Promise<void> {
  const {
    params,
    runtime,
    connectionId,
    signal,
    emit,
    ptyId,
    clientId,
    supportsDesktopViewportClaims
  } = args
  // Why: only unregister the width floor this subscription took (see the multiplex stream's registeredRemoteDesktopDriver note).
  let registeredRemoteDesktopDriver = false

  // Why: a hidden watcher and a visible pane can subscribe to one terminal, so key by client so neither stream evicts the other.
  const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
  const remoteDesktopSubscriptionKey = `json:${allocateTerminalSubscriptionStreamId()}`
  let closed = false
  let outputBatcher: TerminalOutputBatcher | null = null
  let unsubscribeData = (): void => {}
  let unsubscribeFit = (): void => {}
  let stopWatchingLifetime = (): void => {}
  let resolveStream = (): void => {}
  const streamClosed = new Promise<void>((resolve) => {
    resolveStream = resolve
  })
  // Why: register before viewport/snapshot awaits so a socket close can't orphan the stream listeners or its remote-desktop width floor.
  const registration = runtime.registerOwnedSubscriptionCleanup(
    subscriptionId,
    () => {
      stopWatchingLifetime()
      closed = true
      outputBatcher?.flush()
      outputBatcher?.dispose()
      unsubscribeData()
      unsubscribeFit()
      if (registeredRemoteDesktopDriver && clientId) {
        runtime.unregisterRemoteDesktopViewer(ptyId, remoteDesktopSubscriptionKey)
      }
      emit({ type: 'end' })
      resolveStream()
    },
    connectionId
  )
  stopWatchingLifetime = watchSubscriptionLifetime(runtime, ptyId, signal, registration)
  if (closed) {
    // Why: an already-exited pty releases synchronously, so cleanup ran before this setup registers anything.
    return
  }
  try {
    if (clientId && params.client && params.viewport) {
      registeredRemoteDesktopDriver = true
      await updateViewportForClient(
        runtime,
        ptyId,
        remoteDesktopSubscriptionKey,
        params.client,
        params.viewport,
        'desktop',
        'register',
        !supportsDesktopViewportClaims
      )
    }
    if (closed || signal?.aborted) {
      registration.releaseIfCurrent()
      return
    }
    const read = await runtime.readTerminal(params.terminal)
    const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, false)
    if (closed || signal?.aborted) {
      registration.releaseIfCurrent()
      return
    }
    const size = runtime.getTerminalSize(ptyId)
    const displayMode = runtime.getMobileDisplayMode(ptyId)
    const seq = runtime.getLayout(ptyId)?.seq
    emit({
      type: 'scrollback',
      lines: read.tail,
      truncated: isTerminalReadPayloadIncomplete(read),
      serialized: serialized?.data,
      oscLinks: serialized?.oscLinks,
      cwd: serialized?.cwd,
      // Why: an empty snapshot with no PTY size must still report the dims the fit
      // will produce — dimless frames re-armed the mobile fit loop (STA-3337).
      cols: serialized?.cols ?? size?.cols ?? params.viewport?.cols,
      rows: serialized?.rows ?? size?.rows ?? params.viewport?.rows,
      displayMode,
      seq
    })
    outputBatcher = createTerminalOutputBatcher((chunk) => {
      emit({ type: 'data', chunk })
    })
    const unsubscribeStreamData = runtime.subscribeToTerminalData(ptyId, (data) => {
      outputBatcher?.push(data)
    })
    // Why: the legacy JSON stream can feed a live xterm view, so register as a view subscriber; worst case is a withheld model reply, safer than a double reply.
    const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(ptyId)
    unsubscribeData = () => {
      releaseViewSubscriber()
      unsubscribeStreamData()
    }
    unsubscribeFit = runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
      outputBatcher?.flush()
      const mode =
        event.mode === 'mobile-fit'
          ? event.mode
          : (runtime.getRemoteDesktopFitHold?.(ptyId, remoteDesktopSubscriptionKey).mode ??
            'desktop-fit')
      emit({
        type: 'fit-override-changed',
        mode,
        cols: event.cols,
        rows: event.rows
      })
    })
    await streamClosed
  } catch (error) {
    registration.releaseIfCurrent()
    throw error
  }
}

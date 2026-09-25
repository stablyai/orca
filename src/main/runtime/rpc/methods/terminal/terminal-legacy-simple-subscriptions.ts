import { createTerminalOutputBatcher } from './terminal-output-batcher'
import type { TerminalOutputBatcher } from './terminal-output-batcher'
import { isTerminalReadPayloadIncomplete } from './terminal-stream-replay'
import { serializeBudgetedMobileSnapshot } from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import type { TerminalSubscriptionArgs } from './terminal-legacy-subscription-types'
import { allocateTerminalSubscriptionStreamId } from './terminal-subscription-stream-id'

export async function runTerminalLeaseSubscription(args: TerminalSubscriptionArgs): Promise<void> {
  const { registration, emit, ptyId, clientId } = args
  if (!clientId) {
    return
  }
  let resolveStream = (): void => {}
  const streamClosed = new Promise<void>((resolve) => {
    resolveStream = resolve
  })
  registration.setTeardown(resolveStream)
  // Why: chat needs the input-floor ack without registering a view subscriber or transporting duplicate PTY output.
  // A lease-only subscriber has no terminal view, so its cached viewport must never phone-fit the PTY.
  await registration.addMobilePresence(ptyId, clientId, undefined)
  if (registration.released) {
    return
  }
  emit({ type: 'subscribed', streamId: null, lines: [], truncated: false })
  await streamClosed
}

export async function runTerminalJsonSubscription(args: TerminalSubscriptionArgs): Promise<void> {
  const { params, runtime, registration, emit, ptyId, clientId, supportsDesktopViewportClaims } =
    args
  // Why: only unregister the width floor this subscription took (see the multiplex stream's registeredRemoteDesktopDriver note).
  let registeredRemoteDesktopDriver = false
  const remoteDesktopSubscriptionKey = `json:${allocateTerminalSubscriptionStreamId()}`
  let outputBatcher: TerminalOutputBatcher | null = null
  let unsubscribeData = (): void => {}
  let unsubscribeFit = (): void => {}
  let resolveStream = (): void => {}
  const streamClosed = new Promise<void>((resolve) => {
    resolveStream = resolve
  })
  registration.setTeardown(() => {
    outputBatcher?.flush()
    outputBatcher?.dispose()
    unsubscribeData()
    unsubscribeFit()
    if (registeredRemoteDesktopDriver && clientId) {
      runtime.unregisterRemoteDesktopViewer(ptyId, remoteDesktopSubscriptionKey)
    }
    resolveStream()
  })
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
  if (registration.released) {
    return
  }
  const read = await runtime.readTerminal(params.terminal)
  const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, false)
  if (registration.released) {
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
}

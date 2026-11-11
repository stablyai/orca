import { useCallback } from 'react'
import { isTerminalOscLinkRanges } from '../../../../src/shared/terminal/links/terminal-osc-link-ranges'
import * as nativeChatTerminalStream from '../../session/native-chat/mobile-native-chat-terminal-stream'
import {
  createMobileTerminalStreamLifetime,
  subscribeMobileTerminalSafely
} from './mobile-terminal-stream-subscribe'
import { mobileTerminalSnapshotByteBudget } from './terminal-snapshot-byte-budget'
import {
  readTerminalViewportDims,
  runTerminalViewportFitPass
} from './mobile-terminal-viewport-resubscribe'
import { updateTerminalCwdFromStreamEvent } from './terminal-stream-cwd'
import { createTerminalOutputAck, writeTerminalStreamOutput } from '../terminal-output-ack'
import { acceptTerminalLayoutSeq, terminalDisplayModeAdopter } from './terminal-stream-layout'
import { createTerminalStreamResumeCursor } from './terminal-stream-resume'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'

const snapshotByteBudget = mobileTerminalSnapshotByteBudget()

export function useMobileSessionTerminalSubscription(
  scope: MobileSessionTerminalSubscriptionFoundationModel
) {
  const {
    client,
    clientId,
    setTerminalModes,
    terminalCwdRef,
    getTerminalPaneViewport,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    initializedHandlesRef,
    terminalResume,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    webReadyHandlesRef,
    activeHandleRef,
    subscribeSeqRef,
    layoutSeqRef,
    scheduleDelayedAction,
    showToast,
    markNativeChatInputLeaseReady,
    showNativeChatRef,
    getTerminalRef,
    unsubscribeTerminal,
    unsubscribeTerminalRef,
    signalTerminalInventoryRecovery
  } = scope
  const subscribeToTerminal = useCallback(
    (handle: string): boolean => {
      const { viewportRef, viewportMeasuredRef, terminalFrameRef } =
        getTerminalPaneViewport?.(handle) ?? scope
      const diagnostics = terminalDiagnosticsRef.current
      const logSkippedGate = (reason: string) =>
        diagnostics.streamSkipped(handle, reason, handle === activeHandleRef.current)
      if (!client) {
        logSkippedGate('no-client')
        return false
      }
      if (clientId === null) {
        logSkippedGate('no-client-identity')
        return false
      }
      if (terminalUnsubsRef.current.has(handle)) {
        logSkippedGate('already-subscribed')
        return false
      }
      if (subscribingHandlesRef.current.has(handle)) {
        logSkippedGate('subscribe-in-flight')
        return false
      }
      const covered = nativeChatTerminalStream.isTerminalCoveredByNativeChat(
        showNativeChatRef.current,
        activeHandleRef.current,
        handle
      )
      // Covered chat can hold a lease without a mounted WebView; gate readiness only for rendered terminals.
      if (!covered) {
        const ref = getTerminalRef(handle)
        if (!ref) {
          logSkippedGate('no-webview-ref')
          return false
        }
        if (!webReadyHandlesRef.current.has(handle)) {
          logSkippedGate('webview-not-ready')
          return false
        }
        const frame = terminalFrameRef.current
        if (!viewportMeasuredRef.current) {
          // Wait for first frame layout: document ready can arrive before its fitted dimensions.
          if (!frame) {
            logSkippedGate('frame-not-laid-out')
            return false
          }
          // Use the document’s measured cell box so the host serializes scrollback at phone dimensions.
          const dims = ref.fitDimensions(frame)
          diagnostics.viewportMeasured(handle, dims, frame.height)
          if (dims) {
            viewportRef.current = dims
            viewportMeasuredRef.current = true
          }
        }
      }

      subscribingHandlesRef.current.add(handle)
      if (covered) {
        leaseOnlyHandlesRef.current.add(handle)
      } else {
        leaseOnlyHandlesRef.current.delete(handle)
      }
      const seq = (subscribeSeqRef.current.get(handle) ?? 0) + 1
      subscribeSeqRef.current.set(handle, seq)
      diagnostics.streamArmed(handle, seq, viewportRef.current)
      const sentViewport = nativeChatTerminalStream.mobileNativeChatSubscribeViewport(
        covered,
        viewportRef.current
      )

      const lifetime = createMobileTerminalStreamLifetime({
        isSubscriptionCurrent: () => subscribeSeqRef.current.get(handle) === seq,
        currentTerminal: () => getTerminalRef(handle),
        scheduleDelayedAction,
        onEnd: () => {
          unsubscribeTerminalRef.current(handle)
          signalTerminalInventoryRecovery()
        }
      })

      // Lease-only streams carry no output, so only a rendered terminal asks for credit.
      const outputAck = createTerminalOutputAck({
        client,
        capabilities: nativeChatTerminalStream.mobileNativeChatTerminalCapabilities(covered),
        terminal: covered ? undefined : getTerminalRef(handle),
        isCurrent: lifetime.isCurrent
      })
      const canResume = outputAck.capabilities.outputAck === 1
      const resume = createTerminalStreamResumeCursor(terminalResume, handle, canResume)

      // A path switch replays this listener on a new stream whose snapshot covers output the old one never delivered.
      let snapshotStreamId: unknown

      const adoptDisplayMode = terminalDisplayModeAdopter(setTerminalModes, handle)

      // Send viewport in subscribe so host fitting precedes snapshot serialization without a focus/fit race.
      const stopStream = subscribeMobileTerminalSafely(
        client,
        {
          terminal: handle,
          client: { id: clientId, type: 'mobile' as const },
          viewport: sentViewport,
          capabilities: outputAck.capabilities,
          ...resume.params,
          // Omit absent native budgets to preserve older hosts’ subscribe shape.
          ...(snapshotByteBudget === undefined ? {} : { snapshotByteBudget })
        },
        (result) => {
          if (!lifetime.isCurrent()) {
            return
          }
          const data = result as Record<string, unknown>
          diagnostics.firstStreamEvent(handle, seq, data.type)
          if (data.type === 'end' || data.type === 'error') {
            resume.ended(data.type)
            lifetime.end()
            return
          }
          if (data.type === 'subscribed') {
            outputAck.start(data)
            if (resume.subscribed(data)) {
              initializedHandlesRef.current.add(handle)
              snapshotStreamId = data.streamId
              adoptDisplayMode(data.displayMode)
            }
            markNativeChatInputLeaseReady(handle)
            return
          }
          // Covered streams keep input ownership without changing hidden xterm state; returning view gets fresh history.
          if (
            nativeChatTerminalStream.isTerminalCoveredByNativeChat(
              showNativeChatRef.current,
              activeHandleRef.current,
              handle
            )
          ) {
            resume.output(data, false)
            // Ack output dropped unwritten too, or the host's window leaks and the stream stalls.
            outputAck.owe(data)?.()
            return
          }
          if (!acceptTerminalLayoutSeq(layoutSeqRef.current, handle, data)) {
            return
          }
          const eventSeq = typeof data.seq === 'number' ? data.seq : null
          if (data.type === 'scrollback') {
            diagnostics.streamScrollback(handle, seq, eventSeq, data)
            if (data.streamId === snapshotStreamId && initializedHandlesRef.current.has(handle)) {
              return
            }
            updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
            const { hostCols, hostRows } = readTerminalViewportDims(data)
            // Keep absent dimensions unknown; invented 80x24 can never match phone size and causes a refit loop.
            const cols = hostCols ?? viewportRef.current?.cols ?? 80
            const rows = hostRows ?? viewportRef.current?.rows ?? 24
            const initialData = typeof data.serialized === 'string' ? data.serialized : ''
            const oscLinks = isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined
            const ref = getTerminalRef(handle)
            // Mark initialized only after init reaches the WebView or later snapshots are discarded while it stays blank.
            if (!ref) {
              console.log('[fit][session] scrollback DROPPED — no terminal ref', {
                handle: handle.slice(-8),
                cols,
                rows
              })
              return
            }
            const frame = terminalFrameRef.current
            const kittyFlags = data.kittyKeyboardFlags
            ref.init({ cols, rows, initialData, preserveScroll: true, oscLinks, kittyFlags, frame })
            initializedHandlesRef.current.add(handle)
            snapshotStreamId = data.streamId
            resume.snapshotApplied(data.streamId)
            adoptDisplayMode(data.displayMode)
            // Refit after DOM settles because init can see transient scrollWidth.
            lifetime.scheduleSettledFit(ref)
            // Measure viewport-less subscriptions after init, then retry within the bounded per-handle budget.
            runTerminalViewportFitPass({
              handle,
              seq,
              hostCols,
              hostRows,
              displayMode: typeof data.displayMode === 'string' ? data.displayMode : null,
              sentViewport: sentViewport ?? null,
              budget: viewportResubscribeBudgetRef.current,
              diagnostics,
              viewportRef,
              viewportMeasuredRef,
              subscribeSeqRef,
              terminalUnsubsRef,
              terminalFrameRef,
              getTerminalRef,
              unsubscribeTerminal,
              subscribeToTerminal,
              scheduleDelayedAction,
              showToast
            })
          } else if (data.type === 'metadata') {
            updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
          } else if (data.type === 'data') {
            updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
            resume.output(data, getTerminalRef(handle) !== undefined)
            writeTerminalStreamOutput({
              handle,
              chunk: data.chunk as string,
              terminal: getTerminalRef(handle),
              initialized: initializedHandlesRef.current.has(handle),
              settle: outputAck.owe(data)
            })
          } else if (data.type === 'resized') {
            updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
            // Width reflow needs full-buffer reinit; geometry-only events just resize.
            const viewport = viewportMeasuredRef.current ? viewportRef.current : null
            const [cols, rows] = viewportResubscribeBudgetRef.current.observeResize(
              handle,
              data,
              viewport
            )
            const serialized = typeof data.serialized === 'string' ? data.serialized : null
            diagnostics.streamResized(handle, seq, eventSeq, data, getTerminalRef(handle) != null)
            const oscLinks = isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined
            if (serialized != null) {
              resume.invalidate()
              getTerminalRef(handle)?.init({
                cols,
                rows,
                initialData: serialized,
                preserveScroll: true,
                oscLinks,
                kittyFlags: data.kittyKeyboardFlags,
                frame: terminalFrameRef.current
              })
            } else {
              getTerminalRef(handle)?.resize(cols, rows, terminalFrameRef.current)
            }
            adoptDisplayMode(data.displayMode)
            lifetime.scheduleSettledFit(getTerminalRef(handle))
          }
        },
        lifetime.end
      )

      const unsub = lifetime.wrapUnsubscribe(() => {
        // Read the count once this stream stops applying; a caller that drops initialization first wants a snapshot.
        resume.stop(
          initializedHandlesRef.current.has(handle) && getTerminalRef(handle) !== undefined
        )
        stopStream()
      })
      if (lifetime.isCurrent()) {
        terminalUnsubsRef.current.set(handle, unsub)
      } else {
        unsub()
      }
      subscribingHandlesRef.current.delete(handle)
      return true
    },
    [
      client,
      clientId,
      getTerminalRef,
      markNativeChatInputLeaseReady,
      scheduleDelayedAction,
      showToast,
      signalTerminalInventoryRecovery
    ]
  )
  return {
    subscribeToTerminal
  }
}

export type MobileSessionTerminalSubscriptionModel =
  MobileSessionTerminalSubscriptionFoundationModel &
    ReturnType<typeof useMobileSessionTerminalSubscription>

import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'

export function installMultiplexCleanup(state: TerminalMultiplexConnection): void {
  const { runtime, streams, pendingPtyWaitControllers, emit, signal } = state
  state.detachStream = (streamId: number, endVerdict, releaseRemoteDesktopDriver = true): void => {
    const stream = streams.get(streamId)
    if (!stream) {
      return
    }
    stream.outputBatcher.flush()
    stream.outputBatcher.dispose()
    state.ackTotalInFlightBytes = Math.max(0, state.ackTotalInFlightBytes - stream.ackInFlightBytes)
    stream.ackInFlightBytes = 0
    stream.ackPendingOutput = []
    stream.ackPendingOutputBytes = 0
    stream.ackPendingOutputOverflowed = false
    stream.ackRecoverySnapshotInFlight = false
    stream.ackRecoveryHistoryOwed = false
    stream.unsubscribeData()
    stream.unsubscribeResize()
    stream.unsubscribeFit()
    stream.unsubscribeDriver()
    stream.unregisterBinaryHandler()
    streams.delete(streamId)
    state.flushAllAckPendingOutput()
    // Delete before abort so the released exit-waiter's catch cannot re-detach.
    stream.exitWaiterAbort.abort()
    if (stream.isMobile && stream.client?.id) {
      runtime.handleMobileUnsubscribe(stream.ptyId, stream.client.id)
    } else if (
      releaseRemoteDesktopDriver &&
      stream.registeredRemoteDesktopDriver &&
      stream.client?.id
    ) {
      // Release width floors only this stream took; passive streams cannot release peers' floors.
      runtime.unregisterRemoteDesktopViewer(stream.ptyId, stream.remoteDesktopSubscriptionKey)
    }
    if (endVerdict) {
      emit({ type: 'end', streamId, verdict: endVerdict })
    }
  }
  state.cancelPendingPtyWaits = (streamId: number): void => {
    const controllers = pendingPtyWaitControllers.get(streamId)
    if (!controllers) {
      return
    }
    pendingPtyWaitControllers.delete(streamId)
    for (const controller of controllers) {
      controller.abort()
    }
  }
  state.cancelAllPendingPtyWaits = (): void => {
    for (const streamId of Array.from(pendingPtyWaitControllers.keys())) {
      state.cancelPendingPtyWaits(streamId)
    }
  }
  state.closeMultiplex = (): void => {
    if (state.closed) {
      return
    }
    state.closed = true
    signal?.removeEventListener('abort', state.cancelAllPendingPtyWaits)
    state.cancelAllPendingPtyWaits()
    const remoteDesktopKeysByPty = new Map<string, string[]>()
    for (const streamId of Array.from(streams.keys())) {
      const stream = streams.get(streamId)
      if (stream?.registeredRemoteDesktopDriver && !stream.isMobile && stream.client?.id) {
        const keys = remoteDesktopKeysByPty.get(stream.ptyId) ?? []
        keys.push(stream.remoteDesktopSubscriptionKey)
        remoteDesktopKeysByPty.set(stream.ptyId, keys)
      }
      state.detachStream(streamId, null, false)
    }
    // Batch same-PTY connection floors so cleanup scans each registry once.
    for (const [ptyId, subscriptionKeys] of remoteDesktopKeysByPty) {
      void runtime.unregisterRemoteDesktopViewers(ptyId, subscriptionKeys)
    }
    state.unregisterControlHandler()
    state.resolveMultiplex()
  }
}

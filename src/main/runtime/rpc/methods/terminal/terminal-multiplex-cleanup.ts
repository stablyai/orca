import type {
  TerminalMultiplexCleanupStage,
  TerminalMultiplexConnection,
  TerminalMultiplexFlowControlStage
} from './terminal-multiplex-connection'

export function installMultiplexCleanup(
  build: TerminalMultiplexFlowControlStage
): asserts build is TerminalMultiplexCleanupStage {
  const state = build as TerminalMultiplexConnection
  const { runtime, streams, pendingPtyWaitControllers, emit, signal } = state
  state.detachStream = (
    streamId: number,
    emitEnd: boolean,
    releaseRemoteDesktopDriver = true
  ): void => {
    const stream = streams.get(streamId)
    if (!stream) {
      return
    }
    const replacement = stream.sourceRangeReplacement
    stream.sourceRangeReplacement = null
    if (replacement) {
      runtime.rollbackRemoteTerminalSourceRangeReplacement(
        replacement,
        'stream-detached-replacement-aborted'
      )
    }
    stream.outputBatcher.flush()
    stream.outputBatcher.dispose()
    state.detachSourceRangeConsumer(stream, 'stream-detached')
    state.ackTotalInFlightBytes = Math.max(0, state.ackTotalInFlightBytes - stream.ackInFlightBytes)
    stream.ackInFlightBytes = 0
    stream.ackPendingOutput = []
    stream.ackPendingOutputBytes = 0
    stream.ackPendingOutputOverflowed = false
    stream.ackRecoverySnapshotInFlight = false
    stream.unsubscribeData()
    stream.unsubscribeResize()
    stream.unsubscribeFit()
    stream.unsubscribeDriver()
    stream.unregisterBinaryHandler()
    streams.delete(streamId)
    state.flushAllAckPendingOutput()
    // Why: release the runtime exit-waiter for this slot (see the field's note); delete before abort so its .catch no-ops instead of re-detaching.
    stream.exitWaiterAbort.abort()
    if (stream.isMobile && stream.client?.id) {
      runtime.handleMobileUnsubscribe(stream.ptyId, stream.client.id)
    } else if (
      releaseRemoteDesktopDriver &&
      stream.registeredRemoteDesktopDriver &&
      stream.client?.id
    ) {
      // Why: release the width floor only if THIS stream took it, so a passive stream can't release a peer's floor.
      runtime.unregisterRemoteDesktopViewer(stream.ptyId, stream.remoteDesktopSubscriptionKey)
    }
    if (emitEnd) {
      emit({ type: 'end', streamId })
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
      state.detachStream(streamId, false, false)
    }
    // Why: one connection can own many panes on the same PTY; remove floors together so close scans each registry once.
    for (const [ptyId, subscriptionKeys] of remoteDesktopKeysByPty) {
      void runtime.unregisterRemoteDesktopViewers(ptyId, subscriptionKeys)
    }
    state.unregisterControlHandler()
    state.resolveMultiplex()
  }
}

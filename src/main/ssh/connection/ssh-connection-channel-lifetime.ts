type TrackableChannel = Pick<NodeJS.EventEmitter, 'on' | 'once' | 'removeListener'> & {
  closed?: unknown
}

function isTrackableChannel(value: unknown): value is TrackableChannel {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'on' in value &&
    typeof value.on === 'function' &&
    'once' in value &&
    typeof value.once === 'function' &&
    'removeListener' in value &&
    typeof value.removeListener === 'function'
  )
}

export type SshChannelErrorReporter = (error: Error) => void

const reportOrphanChannelError: SshChannelErrorReporter = (error) => {
  console.warn(`[ssh] Unhandled SSH channel error: ${error.message}`)
}

// The tracker's own listener must not be what keeps an error from surfacing.
function hasOnlyTrackerErrorListener(channel: TrackableChannel): boolean {
  return (
    !('listenerCount' in channel) ||
    typeof channel.listenerCount !== 'function' ||
    channel.listenerCount('error') <= 1
  )
}

/** Keeps an unowned channel 'error' from crashing main; attach before handing the channel off. */
export function trackSshConnectionChannelLifetime(
  value: unknown,
  onUnhandledError: SshChannelErrorReporter = reportOrphanChannelError
): void {
  if (!isTrackableChannel(value) || value.closed === true) {
    return
  }
  const channel = value
  const onError = (error: Error) => {
    if (hasOnlyTrackerErrorListener(channel)) {
      onUnhandledError(error)
    }
  }
  channel.on('error', onError)
  channel.once('close', () => {
    channel.removeListener('error', onError)
  })
}

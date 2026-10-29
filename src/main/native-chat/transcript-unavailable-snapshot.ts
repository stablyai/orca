import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'

type InitialSnapshotCallback = NonNullable<SubscribeNativeChatTranscriptArgs['onInitialSnapshot']>

export function emitTranscriptUnavailableSnapshot(
  onInitialSnapshot: InitialSnapshotCallback | undefined,
  message = 'Transcript unavailable'
): boolean {
  if (!onInitialSnapshot) {
    return false
  }
  onInitialSnapshot([], false, 0, message)
  return true
}

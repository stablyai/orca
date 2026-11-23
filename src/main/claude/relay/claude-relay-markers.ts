import type { ProviderRelayWorkMarkers } from '../../provider-relay/app-provider-relays'

/**
 * A turn is work from the model's first reply to its `result`; the daemon never idle-stops it.
 * Status lines after `result` must not count as work, or a finished chat would never idle-stop.
 */
export const CLAUDE_RELAY_WORK_MARKERS: ProviderRelayWorkMarkers = {
  workStarts: ['assistant', 'stream_event'],
  workEnds: ['result']
}

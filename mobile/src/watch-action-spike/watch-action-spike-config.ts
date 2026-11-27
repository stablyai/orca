import Constants from 'expo-constants'
import { Platform } from 'react-native'

// Must match WatchActionSpikeLedger.category in the native module.
export const WATCH_ACTION_SPIKE_CATEGORY = 'orca.watch-spike'

export const WATCH_ACTION_SPIKE_ACTIONS = {
  yes: 'orca.watch-spike.yes',
  no: 'orca.watch-spike.no',
  reply: 'orca.watch-spike.reply'
} as const

// A tap that reaches JS later than this waited for a later launch; production must refuse to act on it.
export const WATCH_ACTION_SPIKE_STALE_MS = 30_000

export function isWatchActionSpikeEnabled(): boolean {
  return Platform.OS === 'ios' && Constants.expoConfig?.extra?.orcaWatchSpike === true
}

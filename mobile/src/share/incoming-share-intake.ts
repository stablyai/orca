import { Platform } from 'react-native'
import {
  clearSharedPayloads,
  getResolvedSharedPayloadsAsync,
  getSharedPayloads
} from 'expo-sharing'
import {
  incomingShareNeedsFileCopies,
  normalizeIncomingShare,
  offerIncomingShare,
  type IncomingSharePayload
} from './incoming-share'

let reading: Promise<boolean> | null = null

async function readNativeShare(): Promise<boolean> {
  const raw: readonly IncomingSharePayload[] = getSharedPayloads()
  if (raw.length === 0) {
    return false
  }
  // Copy streams while the sender's URI grant is live; on failure the raw content:// URIs may still read.
  const payloads = incomingShareNeedsFileCopies(raw)
    ? await getResolvedSharedPayloadsAsync().catch(() => raw)
    : raw
  // expo-sharing keeps the intent until cleared; clearing makes every share read once.
  clearSharedPayloads()
  const share = normalizeIncomingShare(payloads)
  if (!share) {
    return false
  }
  offerIncomingShare(share)
  return true
}

// Resolves true when a new share is waiting for the user to pick its destination.
export function receiveIncomingShare(): Promise<boolean> {
  // ponytail: Android only; an iOS share extension needs expo-sharing's ios config and an app group.
  if (Platform.OS !== 'android') {
    return Promise.resolve(false)
  }
  // Linking, mount and foreground can all ask for the same intent; one read serves them.
  reading ??= readNativeShare()
    .catch(() => false)
    .finally(() => {
      reading = null
    })
  return reading
}

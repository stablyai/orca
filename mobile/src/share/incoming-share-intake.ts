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

function sameShare(
  left: readonly IncomingSharePayload[],
  right: readonly IncomingSharePayload[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (payload, index) =>
        payload.value === right[index]?.value && payload.shareType === right[index]?.shareType
    )
  )
}

async function readNativeShare(): Promise<boolean> {
  for (;;) {
    const raw: readonly IncomingSharePayload[] = getSharedPayloads()
    if (raw.length === 0) {
      return false
    }
    // Copy streams while the sender's URI grant is live; on failure the raw content:// URIs may still read.
    const payloads = incomingShareNeedsFileCopies(raw)
      ? await getResolvedSharedPayloadsAsync().catch(() => raw)
      : raw
    // A newer share can replace the intent while this one resolves; read that one rather than clear it unread.
    if (!sameShare(getSharedPayloads(), raw) || !sameShare(payloads, raw)) {
      continue
    }
    // expo-sharing keeps the intent until cleared; clearing makes every share read once.
    clearSharedPayloads()
    const share = normalizeIncomingShare(payloads)
    if (!share) {
      return false
    }
    offerIncomingShare(share)
    return true
  }
}

// Linking, mount and foreground can all ask at once; reads run in turn so none clears another's intent.
let lastRead: Promise<boolean> = Promise.resolve(false)

// Resolves true when this call found a new share waiting for the user to pick its destination.
export function receiveIncomingShare(): Promise<boolean> {
  // ponytail: Android only; an iOS share extension needs expo-sharing's ios config and an app group.
  if (Platform.OS !== 'android') {
    return Promise.resolve(false)
  }
  lastRead = lastRead.then(readNativeShare).catch(() => false)
  return lastRead
}

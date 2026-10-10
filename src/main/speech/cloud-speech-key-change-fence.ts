import type { CloudSpeechProviderId } from '../../shared/cloud-speech-providers'

// Why: a verified save awaits the network, so it can land after a newer save or clear from
// the desktop pane or a paired phone; the newest change to a provider's key must win.
const keyChangeGenerations = new Map<CloudSpeechProviderId, number>()

export const SUPERSEDED_CLOUD_SPEECH_KEY_SAVE_MESSAGE =
  "A newer change to this provider's key was made; this save was discarded."

/** Starts a key change; any earlier change for the provider stops being current. */
export function beginCloudSpeechKeyChange(providerId: CloudSpeechProviderId): () => boolean {
  const generation = (keyChangeGenerations.get(providerId) ?? 0) + 1
  keyChangeGenerations.set(providerId, generation)
  return () => keyChangeGenerations.get(providerId) === generation
}

/**
 * Verifies a key then saves it, unless a newer save or clear of the same provider started
 * meanwhile; a superseded save throws without touching the stored key.
 */
export async function saveCloudSpeechApiKeyIfLatest(
  providerId: CloudSpeechProviderId,
  verify: () => Promise<void>,
  save: () => void
): Promise<void> {
  const isLatest = beginCloudSpeechKeyChange(providerId)
  await verify()
  if (!isLatest()) {
    throw new Error(SUPERSEDED_CLOUD_SPEECH_KEY_SAVE_MESSAGE)
  }
  save()
}

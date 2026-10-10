export const VOICE_HOST_UNPAIRED_MESSAGE = 'This desktop is no longer paired.'

export type VoiceSettingsHostScope = {
  /** Hosts to connect to: the named host only, or every paired host when none is named. */
  hostIds: string[]
  /** The named host; undefined means "first connected host wins". */
  scopedHostId: string | undefined
  /** A host was named but is not paired any more, so nothing may be configured. */
  unpaired: boolean
}

/**
 * `pairedHostIds` is null until the host list has loaded.
 * Why: a named host never falls back to another desktop, or its API key lands on the wrong machine.
 */
export function resolveVoiceSettingsHostScope(
  pairedHostIds: readonly string[] | null,
  hostId: string | undefined
): VoiceSettingsHostScope {
  if (!hostId) {
    return {
      hostIds: pairedHostIds ? [...pairedHostIds] : [],
      scopedHostId: undefined,
      unpaired: false
    }
  }
  if (!pairedHostIds) {
    return { hostIds: [], scopedHostId: hostId, unpaired: false }
  }
  const paired = pairedHostIds.includes(hostId)
  return { hostIds: paired ? [hostId] : [], scopedHostId: hostId, unpaired: !paired }
}

/** Why: a named host must win even while it is still connecting, or keys land on another desktop. */
export function pickVoiceSettingsClient<T>(
  clients: readonly { hostId: string; state: string; client: T }[],
  hostId: string | undefined
): T | null {
  const candidates = hostId ? clients.filter((entry) => entry.hostId === hostId) : clients
  return candidates.find((entry) => entry.state === 'connected')?.client ?? null
}

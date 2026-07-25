// Per-session mesh voice endpoint resolution.
//
// Until this change, every voice call hardcoded http://100.92.56.51:{4000,8880}.
// That breaks the moment a host is on a different Tailscale node. The mesh
// voice is reached over the SAME overlay the HostProfile already dials: the
// `endpoint` field on the connected host. So the URL is just the host portion
// of that endpoint on the right port — node-a vs node-b is moot, the operator
// pairs once and the host you paired is the host the voice reaches.
//
// Why the default stays: a freshly installed phone with no paired host yet has
// no HostProfile to read from. Keeping the 100.92.56.51 default in ONE place
// here preserves the pre-existing out-of-the-box behaviour without scattering
// the IP across the rest of the codebase.

/** Last-resort fallback used only when no host has been paired yet. */
export const DEFAULT_MESH_VOICE_HOST = '100.92.56.51'

/** LiteLLM synth proxy — /v1/audio/speech, /v1/chat/completions. */
const MESH_VOICE_PROXY_PORT = 4000

/** Kokoro's own API — /v1/audio/voices (the proxy does not expose this). */
const KOKORO_DIRECT_PORT = 8880

/**
 * Extract the host:port pair from a `HostProfile.endpoint` (a `ws://...` URL)
 * or any other mesh URL. Returns null when the input is not a parseable URL
 * with a hostname — caller falls back to the default in that case.
 */
export function extractMeshHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null
  }
  try {
    const url = new URL(endpoint)
    if (!url.hostname) {
      return null
    }
    return url.hostname
  } catch {
    // Not a URL — already a bare host (e.g. "100.92.56.51")?
    const trimmed = endpoint.trim()
    if (trimmed.length > 0 && !/\s/.test(trimmed)) {
      return trimmed
    }
    return null
  }
}

/**
 * URL of the LiteLLM proxy (text→speech + chat completions) for the given
 * HostProfile, or the default host when no profile is supplied.
 */
export function meshVoiceBaseUrlFor(hostEndpoint: string | null | undefined): string {
  const host = extractMeshHost(hostEndpoint) ?? DEFAULT_MESH_VOICE_HOST
  return `http://${host}:${MESH_VOICE_PROXY_PORT}`
}

/**
 * URL of the Kokoro-direct catalogue (`/v1/audio/voices`) for the given
 * HostProfile, or the default host when no profile is supplied.
 */
export function kokoroDirectBaseUrlFor(hostEndpoint: string | null | undefined): string {
  const host = extractMeshHost(hostEndpoint) ?? DEFAULT_MESH_VOICE_HOST
  return `http://${host}:${KOKORO_DIRECT_PORT}`
}

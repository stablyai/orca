import {
  displayHostEndpoint,
  endpointPort,
  normalizeHostEndpoint,
  type NormalizeHostEndpointResult
} from './host-endpoint'

export function normalizeEditedHostEndpoint(
  input: string,
  currentEndpoint: string
): NormalizeHostEndpointResult {
  let currentScheme: 'ws' | 'wss'
  try {
    const protocol = new URL(currentEndpoint).protocol
    if (protocol !== 'ws:' && protocol !== 'wss:') {
      return normalizeHostEndpoint(input)
    }
    currentScheme = protocol === 'wss:' ? 'wss' : 'ws'
  } catch {
    return normalizeHostEndpoint(input)
  }

  const trimmed = input.trim()
  // Why: URL parsing hides default ports. Preserve an unchanged endpoint so a
  // name-only edit cannot rewrite wss://host to wss://host:6768 and reconnect.
  if (trimmed === displayHostEndpoint(currentEndpoint)) {
    return { ok: true, endpoint: currentEndpoint }
  }

  const fallbackPort = endpointPort(currentEndpoint) ?? (currentScheme === 'wss' ? '443' : '80')
  return normalizeHostEndpoint(trimmed, { fallbackPort, fallbackScheme: currentScheme })
}

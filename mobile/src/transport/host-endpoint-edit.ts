import {
  displayHostEndpoint,
  endpointPort,
  endpointScheme,
  normalizeHostEndpoint
} from './host-endpoint'

export type HostEndpointEditResolution =
  | { kind: 'unchanged'; endpoint: string }
  | { kind: 'changed'; endpoint: string }
  | { kind: 'invalid'; error: string }

export function resolveHostEndpointEdit(
  storedEndpoint: string,
  input: string
): HostEndpointEditResolution {
  const displayedEndpoint = displayHostEndpoint(storedEndpoint)
  if (input.trim() === displayedEndpoint) {
    return { kind: 'unchanged', endpoint: storedEndpoint }
  }

  const fallbackScheme = endpointScheme(storedEndpoint)
  const fallbackPort =
    endpointPort(storedEndpoint) ?? (fallbackScheme === 'wss' ? '443' : undefined)
  // Why: a bare wss:// address almost always targets a terminating proxy on 443 — inheriting
  // the current :6768 would aim TLS at a port no edge proxy listens on. Explicit ports still win.
  const inputScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input.trim())?.[1]?.toLowerCase()
  const options = {
    fallbackPort:
      inputScheme === 'wss' && endpointPort(input.trim()) === undefined ? '443' : fallbackPort,
    fallbackScheme
  }
  const normalizedInput = normalizeHostEndpoint(input, options)
  if (!normalizedInput.ok) {
    return { kind: 'invalid', error: normalizedInput.error }
  }

  const normalizedDisplay = normalizeHostEndpoint(displayedEndpoint, options)
  if (
    sameEndpointAuthority(normalizedInput.endpoint, storedEndpoint) ||
    (normalizedDisplay.ok &&
      sameEndpointAuthority(normalizedInput.endpoint, normalizedDisplay.endpoint))
  ) {
    return { kind: 'unchanged', endpoint: storedEndpoint }
  }

  return {
    kind: 'changed',
    endpoint: normalizedInput.endpoint + endpointRouteSuffix(storedEndpoint)
  }
}

function sameEndpointAuthority(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function endpointRouteSuffix(endpoint: string): string {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(.*)$/.exec(endpoint)
  return match?.[1] ?? ''
}

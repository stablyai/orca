import type { Translate } from '../../i18n/mobile-i18n'
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
  input: string,
  t: Translate
): HostEndpointEditResolution {
  const displayedEndpoint = displayHostEndpoint(storedEndpoint)
  if (input.trim() === displayedEndpoint) {
    return { kind: 'unchanged', endpoint: storedEndpoint }
  }

  const fallbackScheme = endpointScheme(storedEndpoint)
  const fallbackPort = /^wss:\/\//i.test(input.trim())
    ? '443'
    : (endpointPort(storedEndpoint) ?? (fallbackScheme === 'wss' ? '443' : undefined))
  const options = { fallbackPort, fallbackScheme }
  const normalizedInput = normalizeHostEndpoint(input, options, t)
  if (!normalizedInput.ok) {
    return { kind: 'invalid', error: normalizedInput.error }
  }

  const normalizedDisplay = normalizeHostEndpoint(displayedEndpoint, options, t)
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

import {
  displayHostEndpoint,
  endpointPort,
  endpointScheme,
  normalizeHostEndpoint
} from './host-endpoint'

export function resolveHostEndpointEdit(storedEndpoint: string, input: string) {
  const fallbackScheme = endpointScheme(storedEndpoint)
  const fallbackPort =
    endpointPort(storedEndpoint) ?? (fallbackScheme === 'wss' ? '443' : undefined)
  return {
    addressChanged: input !== displayHostEndpoint(storedEndpoint),
    normalizedEndpoint: normalizeHostEndpoint(input, { fallbackPort, fallbackScheme })
  }
}

import type { DeviceEntry } from './device-entry'

export class DeviceRegistryUnavailableError extends Error {
  readonly code = 'registry_unavailable'
  constructor(
    readonly reason: 'conflict' | 'contended' | 'snapshot' | 'io',
    readonly winner: DeviceEntry[] | null,
    cause?: unknown
  ) {
    super('Device registry unavailable; retry the operation.', { cause })
  }
}

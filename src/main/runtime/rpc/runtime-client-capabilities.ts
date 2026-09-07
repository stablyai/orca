import type { RuntimeCapability } from '../../../shared/protocol-version'

export function parseRuntimeClientCapabilities(value: unknown): readonly RuntimeCapability[] {
  if (!Array.isArray(value) || value.length > 64) {
    return []
  }
  const capabilities = value.filter(
    (capability): capability is RuntimeCapability =>
      typeof capability === 'string' && capability.length > 0 && capability.length <= 128
  )
  return capabilities.length === value.length ? capabilities : []
}

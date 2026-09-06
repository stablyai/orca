import type { GhosttyImportSource } from '../../shared/global-settings-types'

const VALID_SOURCE_KINDS = new Set(['auto', 'chooseFile'])

export function validateGhosttyImportSource(source: unknown): GhosttyImportSource | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null
  }
  const entries = Object.entries(source)
  if (entries.length !== 1 || entries[0]?.[0] !== 'kind') {
    return null
  }
  const kind = entries[0][1]
  if (typeof kind !== 'string' || !VALID_SOURCE_KINDS.has(kind)) {
    return null
  }
  return { kind } as GhosttyImportSource
}

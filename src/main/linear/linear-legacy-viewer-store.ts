import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { getLegacyViewerPath } from './linear-credential-paths'
import type { LinearViewer } from '../../shared/linear/workspace-types'

let cachedLegacyViewer: LinearViewer | null = null
let legacyViewerLoadedFromDisk = false

function readLegacyViewerFromDisk(): LinearViewer | null {
  const path = getLegacyViewerPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearViewer>
    if (typeof parsed?.displayName !== 'string' || typeof parsed?.organizationName !== 'string') {
      return null
    }
    return {
      displayName: parsed.displayName,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      organizationId: typeof parsed.organizationId === 'string' ? parsed.organizationId : undefined,
      organizationName: parsed.organizationName,
      organizationUrlKey:
        typeof parsed.organizationUrlKey === 'string' ? parsed.organizationUrlKey : undefined
    }
  } catch {
    return null
  }
}

export function getLegacyViewer(): LinearViewer | null {
  if (!legacyViewerLoadedFromDisk) {
    cachedLegacyViewer = readLegacyViewerFromDisk()
    legacyViewerLoadedFromDisk = true
  }
  return cachedLegacyViewer
}

export function clearLegacyViewerOnDisk(): void {
  try {
    unlinkSync(getLegacyViewerPath())
  } catch {
    // Legacy viewer cleanup is best-effort when storage is absent or unavailable.
  }
}

// Keep the empty cache loaded so removal does not trigger another disk read.
export function forgetLegacyViewer(): void {
  cachedLegacyViewer = null
  legacyViewerLoadedFromDisk = true
}

export function resetLegacyViewerCache(): void {
  cachedLegacyViewer = null
  legacyViewerLoadedFromDisk = false
}

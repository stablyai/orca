import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireNative = createRequire(import.meta.url)
let reader: (() => unknown) | null | undefined

// Why no Electron import: the headless runtime loads this too, and falls back to memory_pressure.
function addonCandidates(): string[] {
  const candidates: string[] = []
  if (typeof process.resourcesPath === 'string') {
    candidates.push(join(process.resourcesPath, 'orca_memory_status.node'))
  }
  // Dev runs keep the addon in out/native; bundled main code sits in out/main or out/main/chunks.
  // Why __dirname: both CommonJS bundles (desktop main and headless) define it; import.meta.dirname is empty there.
  for (const up of ['..', '../..']) {
    candidates.push(join(__dirname, up, 'native', 'orca_memory_status.node'))
  }
  return candidates
}

function loadReader(): (() => unknown) | null {
  for (const candidate of addonCandidates()) {
    try {
      const addon: unknown = requireNative(candidate)
      if (
        typeof addon === 'object' &&
        addon !== null &&
        'freePercent' in addon &&
        typeof addon.freePercent === 'function'
      ) {
        const freePercent = addon.freePercent
        return () => freePercent()
      }
    } catch {
      // Try the next location; missing everywhere means memory_pressure stays the source.
    }
  }
  return null
}

/** The kernel's free-memory percentage without spawning `memory_pressure`; null when unavailable. */
export function readDarwinMemoryFreePercent(): number | null {
  if (process.platform !== 'darwin') {
    return null
  }
  // Why undefined, not ??=: a failed load is remembered as null, so it never retries per snapshot.
  if (reader === undefined) {
    reader = loadReader()
  }
  if (!reader) {
    return null
  }
  try {
    const value = reader()
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
      ? value
      : null
  } catch {
    return null
  }
}

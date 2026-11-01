import { app } from 'electron'
import { totalmem } from 'node:os'

const RENDERER_HEAP_ENV_VAR = 'ORCA_RENDERER_HEAP_MB'
const BYTES_PER_GIB = 1024 * 1024 * 1024
// Heavy sessions exceed Chromium's ~RAM/4 default; reclaim headroom within V8's 4GB cage. Keep low-RAM defaults to avoid OS kills/swap; 7.5GiB includes 8GB Linux machines whose MemTotal excludes reserved RAM.
const RENDERER_HEAP_MIN_TOTAL_GIB = 7.5
const RENDERER_HEAP_RAM_FRACTION = 0.4
const RENDERER_HEAP_FLOOR_MB = 3072
// Pointer compression caps V8 at 4096MB even if the flag requests more.
const RENDERER_HEAP_CAP_MB = 4096

type HeapOverride = number | 'disable' | undefined

function parseRendererHeapOverrideMb(value: string | undefined): HeapOverride {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '') {
    return undefined
  }
  // Allow operators/E2E to retain Chromium defaults without changing RAM tiers.
  if (normalized === 'default' || normalized === 'off' || normalized === 'none') {
    return 'disable'
  }
  const parsed = Number(normalized)
  // Typos use RAM tiers; explicit nonpositive values opt out.
  if (!Number.isFinite(parsed)) {
    return undefined
  }
  if (parsed <= 0) {
    return 'disable'
  }
  // Fractional overrides can floor to zero, which is an invalid heap flag; treat as opt-out.
  const flooredMb = Math.floor(parsed)
  return flooredMb <= 0 ? 'disable' : flooredMb
}

/** Null keeps Chromium's memory default; compute tiers/overrides without spawning Electron. */
export function computeRendererHeapCeilingMb(
  totalMemoryBytes: number,
  envOverride?: string
): number | null {
  const override = parseRendererHeapOverrideMb(envOverride)
  if (override === 'disable') {
    return null
  }
  if (typeof override === 'number') {
    return override
  }
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return null
  }
  const totalGib = totalMemoryBytes / BYTES_PER_GIB
  if (totalGib < RENDERER_HEAP_MIN_TOTAL_GIB) {
    return null
  }
  const targetMb = Math.floor(totalGib * RENDERER_HEAP_RAM_FRACTION) * 1024
  return Math.min(RENDERER_HEAP_CAP_MB, Math.max(RENDERER_HEAP_FLOOR_MB, targetMb))
}

export function enableRendererHeapHeadroom(
  options: { totalMemoryBytes?: number; env?: NodeJS.ProcessEnv } = {}
): void {
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem()
  const envOverride = (options.env ?? process.env)[RENDERER_HEAP_ENV_VAR]
  const ceilingMb = computeRendererHeapCeilingMb(totalMemoryBytes, envOverride)
  if (ceilingMb === null) {
    return
  }
  const existing = app.commandLine.getSwitchValue('js-flags')
  // Respect explicit heap flags rather than append an ignored duplicate.
  if (existing.includes('--max-old-space-size')) {
    return
  }
  const flag = `--max-old-space-size=${ceilingMb}`
  // Set process-wide js-flags before ready so newly spawned V8 isolates inherit them.
  app.commandLine.appendSwitch('js-flags', existing ? `${existing} ${flag}` : flag)
}

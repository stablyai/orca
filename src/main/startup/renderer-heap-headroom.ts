import { app } from 'electron'
import { totalmem } from 'node:os'

const RENDERER_HEAP_ENV_VAR = 'ORCA_RENDERER_HEAP_MB'
const BYTES_PER_GIB = 1024 * 1024 * 1024
// Why: Chromium sizes the renderer's V8 old-space heap from a physical-memory
// heuristic (~RAM/4), so an 8 GB machine caps the renderer near ~2.2 GB even
// though V8's pointer-compression cage allows up to ~4 GB. Heavy Orca sessions
// (many agent terminals × scrollback, PR/git caches, React tree) legitimately
// reach that low default and V8 aborts with an OOM — the dominant renderer
// crash in the crash channel. Reclaim the unused headroom up to the 4 GB cage
// on machines that have the RAM. Requests above 4096 are silently capped by the
// pointer-compression cage, so 4096 is the real ceiling — we cannot go higher.
// Machines below ~8 GB keep Chromium's default: raising their ceiling would
// trade a clean OOM for OS memory-pressure kills / swap thrash.
// Why 7.5 not 8: os.totalmem() on Linux reports MemTotal, which excludes
// kernel/firmware-reserved RAM, so a real 8 GB machine reports ~7.7 GiB. Gating
// at exactly 8 would wrongly exclude 8 GB Linux boxes (a crashing population)
// while still cleanly excluding 6 GB machines (which report ~5.7 GiB).
const RENDERER_HEAP_MIN_TOTAL_GIB = 7.5
const RENDERER_HEAP_RAM_FRACTION = 0.4
const RENDERER_HEAP_FLOOR_MB = 3072
// V8 pointer-compression cage hard limit; --max-old-space-size above this is ignored.
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
  // Why: give operators an explicit opt-out (and E2E a way to pin the default)
  // without editing the RAM tiers.
  if (normalized === 'default' || normalized === 'off' || normalized === 'none') {
    return 'disable'
  }
  const parsed = Number(normalized)
  // Why: ignore an unparseable value (typo) and fall through to the RAM tiers,
  // but treat an explicit non-positive number as an opt-out.
  if (!Number.isFinite(parsed)) {
    return undefined
  }
  if (parsed <= 0) {
    return 'disable'
  }
  // Why: a fractional value in (0,1) floors to 0, which would emit an invalid
  // --max-old-space-size=0. Treat a floored-to-0 override as an opt-out too.
  const flooredMb = Math.floor(parsed)
  return flooredMb <= 0 ? 'disable' : flooredMb
}

/**
 * Renderer V8 old-space ceiling (MB) to request via --max-old-space-size, or
 * null to keep Chromium's physical-memory default. Pure so the RAM tiers and
 * the env override are unit-testable without spawning Electron.
 */
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
  // Why: respect an explicit --max-old-space-size someone already set (e.g. via
  // ELECTRON_EXTRA_LAUNCH_ARGS) instead of stacking a second, ignored value.
  if (existing.includes('--max-old-space-size')) {
    return
  }
  const flag = `--max-old-space-size=${ceilingMb}`
  // Why: js-flags is process-wide and must be set before app 'ready' so it
  // reaches renderer/utility V8 isolates when Chromium spawns them.
  app.commandLine.appendSwitch('js-flags', existing ? `${existing} ${flag}` : flag)
}

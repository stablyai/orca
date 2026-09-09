/**
 * `office.probe` — is `officecli` on this execution host, and what can it do?
 *
 * Detect, never install. The result feeds both the missing-binary notice (which names the host and
 * shows a command the reader runs themselves) and the Live toggle's enable/disable reason.
 */
import {
  OFFICE_PROBE_TIMEOUT_MS,
  type OfficeHostPlatform,
  type OfficeProbeOutcome,
  type OfficeProbeResult
} from '../../shared/office-preview-contracts'
import { OfficecliMissingError, runOfficecli } from './officecli-invocation'
import { NATIVE_OFFICECLI_LANE, officecliLaneKey, type OfficecliLane } from './officecli-lane'
import { invalidateOfficecliResolution, resolveOfficecli } from './officecli-resolution'
import { officecliVersionArgs } from './officecli-argv'

function lanePlatform(lane: OfficecliLane): OfficeHostPlatform {
  if (lane.kind === 'wsl') {
    return 'linux'
  }
  // A lookup rather than a switch: `NodeJS.Platform` has a dozen members we deliberately do not
  // distinguish, and an exhaustive switch over them would be noise for no reader.
  const platforms: Partial<Record<NodeJS.Platform, OfficeHostPlatform>> = {
    darwin: 'darwin',
    win32: 'win32',
    linux: 'linux'
  }
  return platforms[process.platform] ?? 'unknown'
}

const ABSENT = (lane: OfficecliLane): OfficeProbeResult => ({
  installed: false,
  version: null,
  supportsWatch: false,
  platform: lanePlatform(lane),
  resolvedPath: null
})

/** `--version` prints the bare version on one line. Anything else is reported as unknown. */
function parseVersion(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().length > 0)
  const match = line ? /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(line) : null
  return match?.[1] ?? null
}

async function probeUncached(lane: OfficecliLane): Promise<OfficeProbeResult> {
  const resolved = await resolveOfficecli(lane)
  if (!resolved.path) {
    return ABSENT(lane)
  }
  try {
    const version = await runOfficecli(officecliVersionArgs(), {
      lane,
      timeoutMs: OFFICE_PROBE_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024
    })
    if (version.code !== 0) {
      // A binary that is present but cannot answer `--version` is not usable, and reporting it as
      // installed would send the reader looking for a rendering bug instead of a broken install.
      return ABSENT(lane)
    }
    const help = await runOfficecli(['--help'], {
      lane,
      timeoutMs: OFFICE_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    return {
      installed: true,
      version: parseVersion(version.stdout),
      // Any indentation, not exactly two spaces: a help layout that re-indents its command table
      // would otherwise silently report a binary that cannot watch, and the live toggle would go
      // dark with no way to tell that from an old build.
      supportsWatch: /^[ \t]+watch\b/m.test(help.stdout),
      platform: lanePlatform(lane),
      resolvedPath: resolved.path
    }
  } catch (error) {
    if (error instanceof OfficecliMissingError) {
      return ABSENT(lane)
    }
    throw error
  }
}

const cache = new Map<string, Promise<OfficeProbeResult>>()

export function probeOfficecli(
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeProbeOutcome> {
  const key = officecliLaneKey(lane)
  let pending = cache.get(key)
  if (!pending) {
    pending = probeUncached(lane).catch((): OfficeProbeResult => {
      cache.delete(key)
      return ABSENT(lane)
    })
    cache.set(key, pending)
  }
  return pending.then((result) => ({ ok: true as const, ...result }))
}

/**
 * Drop the cached answer. Called on host reconnect and by the preview's Retry control: a cached
 * "not installed" surviving an install is how a preview keeps telling someone to install what
 * they already installed.
 */
export function invalidateOfficeProbe(lane?: OfficecliLane): void {
  if (lane) {
    cache.delete(officecliLaneKey(lane))
  } else {
    cache.clear()
  }
  invalidateOfficecliResolution(lane)
}

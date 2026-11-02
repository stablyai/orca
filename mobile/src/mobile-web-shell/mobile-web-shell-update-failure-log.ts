import { z } from 'zod'
import { MobileWebBundleErrorCodeSchema } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import { joinUri } from './generation-cache-uri'
import type { GenerationFileSystem } from './generation-store-file-system'
import {
  MOBILE_WEB_SHELL_UPDATE_FAILURE_OUTCOMES,
  MOBILE_WEB_SHELL_UPDATE_FAILURE_REASONS,
  MOBILE_WEB_SHELL_UPDATE_FAILURE_WALLS,
  type MobileWebShellUpdateFailure
} from './mobile-web-shell-update-failure'

// Keep enough history to distinguish one bad download from repeated failures without growing diagnostic storage.
export const MAX_UPDATE_FAILURES_PER_HOST = 5
// Bound all hosts too; cached-host eviction does not bound failure-log hosts.
export const MAX_UPDATE_FAILURES = 30

const UPDATE_FAILURE_LOG_FILE_NAME = 'update-failures.json'

const BUILD_ID_PATTERN = /^[a-f0-9]{64}$/

const BuildIdSchema = z.string().regex(BUILD_ID_PATTERN).nullable()

const UpdateFailureSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    at: z.number().int().nonnegative(),
    reason: z.enum(MOBILE_WEB_SHELL_UPDATE_FAILURE_REASONS),
    hostCode: MobileWebBundleErrorCodeSchema.nullable(),
    offeredBuildId: BuildIdSchema,
    cachedBuildId: BuildIdSchema,
    outcome: z.enum(MOBILE_WEB_SHELL_UPDATE_FAILURE_OUTCOMES),
    wall: z.enum(MOBILE_WEB_SHELL_UPDATE_FAILURE_WALLS).nullable()
  })
  .strict()

// Drop non-digest build ids rather than persist arbitrary host text.
function recordableBuildId(buildId: string | null): string | null {
  return buildId !== null && BUILD_ID_PATTERN.test(buildId) ? buildId : null
}

export function appendUpdateFailure(
  entries: readonly MobileWebShellUpdateFailure[],
  failure: MobileWebShellUpdateFailure
): MobileWebShellUpdateFailure[] {
  const entry = {
    ...failure,
    offeredBuildId: recordableBuildId(failure.offeredBuildId),
    cachedBuildId: recordableBuildId(failure.cachedBuildId)
  }
  const all = [...entries, entry]
  const sameHost = all.filter((candidate) => candidate.hostId === entry.hostId)
  const evicted = new Set(
    sameHost.slice(0, Math.max(0, sameHost.length - MAX_UPDATE_FAILURES_PER_HOST))
  )
  const kept = all.filter((candidate) => !evicted.has(candidate))
  return kept.slice(Math.max(0, kept.length - MAX_UPDATE_FAILURES))
}

function logUri(fs: GenerationFileSystem): string {
  return joinUri(fs.rootUri, UPDATE_FAILURE_LOG_FILE_NAME)
}

// Treat unreadable data as absent and skip bad entries; diagnostics must not prevent shell use.
export async function readUpdateFailureLog(
  fs: GenerationFileSystem
): Promise<MobileWebShellUpdateFailure[]> {
  const text = await fs.readText(logUri(fs)).catch(() => null)
  if (text === null) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed.flatMap((candidate: unknown) => {
    const entry = UpdateFailureSchema.safeParse(candidate)
    return entry.success ? [entry.data] : []
  })
}

async function writeUpdateFailureLog(
  fs: GenerationFileSystem,
  entries: readonly MobileWebShellUpdateFailure[]
): Promise<void> {
  if (entries.length === 0) {
    await fs.delete(logUri(fs))
    return
  }
  // Validate again before writing so unlisted fields cannot reach disk.
  const checked = entries.flatMap((entry) => {
    const valid = UpdateFailureSchema.safeParse(entry)
    return valid.success ? [valid.data] : []
  })
  await fs.writeText(logUri(fs), JSON.stringify(checked))
}

export async function recordUpdateFailureIn(
  fs: GenerationFileSystem,
  failure: MobileWebShellUpdateFailure
): Promise<void> {
  await writeUpdateFailureLog(fs, appendUpdateFailure(await readUpdateFailureLog(fs), failure))
}

export async function forgetHostUpdateFailuresIn(
  fs: GenerationFileSystem,
  hostId: string
): Promise<void> {
  const entries = await readUpdateFailureLog(fs)
  const kept = entries.filter((entry) => entry.hostId !== hostId)
  if (kept.length !== entries.length) {
    await writeUpdateFailureLog(fs, kept)
  }
}

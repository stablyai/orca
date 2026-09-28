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

/**
 * The last few update failures per host, in the cache root beside the host index.
 *
 * Five per host: Troubleshoot shows the newest, and four behind it are enough to tell one bad
 * download from a host that fails every launch, while the file stays a few kilobytes.
 */
export const MAX_UPDATE_FAILURES_PER_HOST = 5
/** A ceiling across hosts too, because hosts are not otherwise bounded: four hosts' worth. */
export const MAX_UPDATE_FAILURES = 20

const UPDATE_FAILURE_LOG_FILE_NAME = 'update-failures.json'

/** Generation ids are sha256 hex; anything else is not recorded as one. */
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

/** A build id the host sent that is not a digest is dropped rather than kept: it is host text. */
function recordableBuildId(buildId: string | null): string | null {
  return buildId !== null && BUILD_ID_PATTERN.test(buildId) ? buildId : null
}

/** Oldest first. Appends, then evicts oldest-first: per host, then across hosts. */
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

/** Unreadable reads as empty, entry by entry: a diagnostic must never cost the shell anything. */
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
  // Re-validated on the way out as well, so nothing but the listed fields ever reaches disk.
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

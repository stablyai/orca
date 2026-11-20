import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventProps } from '../../shared/telemetry/telemetry-event-classification'
import type {
  CodexHistoryCleanupKind,
  CodexHistoryCleanupMode
} from '../codex/history/cleanup-policy/codex-history-cleanup-policy'
import type { CleanupKindTally } from '../codex/history/shared-store/codex-history-cleanup-sweep-tally'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'
import { isTelemetryEnabled, track } from './client'

type Props = EventProps<'codex_history_cleanup_sweep'>

function countBucket(count: number): Props['candidates_bucket'] {
  return count === 0
    ? '0'
    : count === 1
      ? '1'
      : count <= 10
        ? '2_10'
        : count <= 100
          ? '11_100'
          : count <= 500
            ? '101_500'
            : 'gt_500'
}

const MB = 1024 * 1024
function bytesBucket(bytes: number): Props['bytes_bucket'] {
  return bytes === 0
    ? '0'
    : bytes < MB
      ? 'lt_1mb'
      : bytes < 100 * MB
        ? '1mb_100mb'
        : bytes < 1024 * MB
          ? '100mb_1gb'
          : bytes < 10 * 1024 * MB
            ? '1gb_10gb'
            : 'gte_10gb'
}

let sent: Promise<Set<string>> | null = null

async function readSent(markerPath: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Sends a finished sweep's tally for each kind it worked on, once per install, kind, policy
 * revision and mode: the marker file remembers what went. Without consent nothing is sent or kept.
 */
export async function reportCodexHistoryCleanupOnce(args: {
  markerPath: string
  revision: number
  modes: Record<CodexHistoryCleanupKind, CodexHistoryCleanupMode>
  result: Record<CodexHistoryCleanupKind, CleanupKindTally> & { budgetHit: boolean }
}): Promise<void> {
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    return
  }
  for (const kind of ['rollouts', 'databases'] as const) {
    const mode = args.modes[kind]
    const tally = args.result[kind]
    // A sweep with nothing to judge says nothing about the policy; a later one reports instead.
    if (mode === 'off' || tally.candidates === 0 || !isTelemetryEnabled()) {
      continue
    }
    sent ??= readSent(args.markerPath)
    const keys = await sent
    const key = `${kind}:${args.revision}:${mode}`
    if (keys.has(key)) {
      continue
    }
    const tracked = track('codex_history_cleanup_sweep', {
      kind,
      mode,
      revision: args.revision,
      platform,
      candidates_bucket: countBucket(tally.candidates),
      eligible_bucket: countBucket(tally.eligible),
      deleted_bucket: countBucket(tally.deleted),
      bytes_bucket: bytesBucket(tally.bytes),
      skipped_changed_bucket: countBucket(tally.skipped.changed),
      skipped_hard_linked_bucket: countBucket(tally.skipped.hard_linked),
      skipped_open_bucket: countBucket(tally.skipped.open),
      skipped_open_unknown_bucket: countBucket(tally.skipped.open_unknown),
      skipped_rehash_mismatch_bucket: countBucket(tally.skipped.rehash_mismatch),
      skipped_unshared_bucket: countBucket(tally.skipped.unshared),
      skipped_not_proven_shared_bucket: countBucket(tally.skipped.not_proven_shared),
      skipped_unlink_failed_bucket: countBucket(tally.skipped.unlink_failed),
      skipped_transient_capped_bucket: countBucket(tally.skipped.transient_capped),
      skipped_oversized_bucket: countBucket(tally.skipped.oversized),
      skipped_budget_bucket: countBucket(tally.skipped.budget),
      budget_hit: args.result.budgetHit
    })
    if (!tracked) {
      continue
    }
    keys.add(key)
    try {
      await mkdir(dirname(args.markerPath), { recursive: true })
      await writePluginFileAtomically(args.markerPath, `${JSON.stringify([...keys])}\n`)
    } catch (error) {
      console.warn('[codex-account-history] Cleanup telemetry marker not saved:', error)
    }
  }
}

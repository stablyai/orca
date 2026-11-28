import type { WorkspaceCleanupRunTrigger } from '../../shared/workspace-cleanup/workspace-cleanup-run'
import type { ChatHistorySweepResult } from '../workspaces/cleanup/chat-history/gone-workspace-folder-groups'
import type { EventProps } from '../../shared/telemetry/telemetry-event-classification'
import { track } from './client'

type CountBucket = EventProps<'deleted_chats_sweep'>['orca_chats_bucket']
type DurationBucket = EventProps<'deleted_chats_sweep'>['elapsed_ms_bucket']

function countBucket(value: number): CountBucket {
  return value <= 0
    ? '0'
    : value <= 10
      ? '1_10'
      : value <= 100
        ? '11_100'
        : value <= 1000
          ? '101_1000'
          : value <= 10_000
            ? '1001_10000'
            : 'gt_10000'
}

function durationBucket(ms: number): DurationBucket {
  return ms < 1000
    ? 'lt_1s'
    : ms < 10_000
      ? '1s_10s'
      : ms < 60_000
        ? '10s_1m'
        : ms < 600_000
          ? '1m_10m'
          : ms < 3_600_000
            ? '10m_1h'
            : 'gte_1h'
}

function bytesBucket(bytes: number): EventProps<'deleted_chats_discard'>['bytes_bucket'] {
  const mb = bytes / 1_000_000
  return mb < 10
    ? 'lt_10mb'
    : mb < 100
      ? '10mb_100mb'
      : mb < 1000
        ? '100mb_1gb'
        : mb < 10_000
          ? '1gb_10gb'
          : 'gte_10gb'
}

export function reportDeletedChatsSweep(sweep: {
  trigger: WorkspaceCleanupRunTrigger
  orcaChatsOn: boolean
  transcriptsOn: boolean
  orcaChats: ChatHistorySweepResult
  transcripts: ChatHistorySweepResult
  elapsedMs: number
}): void {
  track('deleted_chats_sweep', {
    trigger: sweep.trigger,
    orca_chats_on: sweep.orcaChatsOn,
    transcripts_on: sweep.transcriptsOn,
    orca_chats_bucket: countBucket(sweep.orcaChats.deleted),
    orca_failed_bucket: countBucket(sweep.orcaChats.failed),
    orca_skipped_bucket: countBucket(sweep.orcaChats.skipped ?? 0),
    transcripts_bucket: countBucket(sweep.transcripts.deleted),
    transcripts_failed_bucket: countBucket(sweep.transcripts.failed),
    elapsed_ms_bucket: durationBucket(sweep.elapsedMs)
  })
}

/** One background pass deleting deleted chats' saved rows; reported once, if it did anything. */
export class DeletedChatsDiscardPass {
  failed = false
  private chats = 0
  private bytes = 0
  private readonly startedAt = performance.now()

  note(page: { bytes: number; discarded: boolean }): void {
    this.bytes += page.bytes
    this.chats += page.discarded ? 1 : 0
  }

  report(): void {
    if (this.chats === 0 && !this.failed) {
      return
    }
    track('deleted_chats_discard', {
      chats_bucket: countBucket(this.chats),
      bytes_bucket: bytesBucket(this.bytes),
      failed: this.failed,
      elapsed_ms_bucket: durationBucket(performance.now() - this.startedAt)
    })
  }
}

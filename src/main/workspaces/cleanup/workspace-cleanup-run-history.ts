import {
  readSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from '../../filesystem/sidecar-snapshot-file'
import {
  WORKSPACE_CLEANUP_REPORT_RUN_LIMIT,
  type WorkspaceCleanupRun
} from '../../../shared/workspace-cleanup/workspace-cleanup-run'

const HISTORY_FILE_NAME = 'orca-workspace-cleanup-runs.json'
const HISTORY_VERSION = 1

type PersistedWorkspaceCleanupRunHistory = {
  version: number
  runs: WorkspaceCleanupRun[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPersistedRun(value: unknown): value is WorkspaceCleanupRun {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.trigger === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.finishedAt === 'number' &&
    isRecord(value.counts) &&
    typeof value.freedBytes === 'number' &&
    Array.isArray(value.rows)
  )
}

function parseHistory(parsed: unknown): WorkspaceCleanupRun[] {
  if (!isRecord(parsed) || parsed.version !== HISTORY_VERSION || !Array.isArray(parsed.runs)) {
    return []
  }
  return parsed.runs.filter(isPersistedRun)
}

/** Newest first; a missing or unreadable file is an empty history. */
export async function readWorkspaceCleanupRunHistory(
  directory: string
): Promise<WorkspaceCleanupRun[]> {
  const file = sidecarSnapshotFile(directory, HISTORY_FILE_NAME)
  return withSidecarSnapshotQueue(file, async () => parseHistory(await readSidecarSnapshot(file)))
}

export async function appendWorkspaceCleanupRun(
  directory: string,
  run: WorkspaceCleanupRun
): Promise<void> {
  const file = sidecarSnapshotFile(directory, HISTORY_FILE_NAME)
  await withSidecarSnapshotQueue(file, async () => {
    const runs = [run, ...parseHistory(await readSidecarSnapshot(file))].slice(
      0,
      WORKSPACE_CLEANUP_REPORT_RUN_LIMIT
    )
    await writeSidecarSnapshot(file, {
      version: HISTORY_VERSION,
      runs
    } satisfies PersistedWorkspaceCleanupRunHistory)
  })
}

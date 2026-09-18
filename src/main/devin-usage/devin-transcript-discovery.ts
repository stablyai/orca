import { join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { SessionSidecarObservation } from '../ai-vault/session-sidecar-stat'
import { resolveDevinTranscriptsDir } from '../devin/devin-cli-data-dir'
import type { DevinUsageProcessedFile } from './types'

// Why gated: a DEVIN_HOME override can point the transcripts root at a
// \\wsl$ UNC path, where a raw syscall on a stalled distro would hang the
// whole scan (STA-4049).
export async function listDevinTranscriptFiles(): Promise<string[]> {
  const transcriptsDir = resolveDevinTranscriptsDir()
  try {
    const entries = await wslGatedReaddir(transcriptsDir, 'scan')
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => join(transcriptsDir, entry.name))
      .sort()
  } catch (error) {
    // Why: only a genuinely missing transcripts dir means "no data". A
    // transient EACCES/EIO/WSL refusal must surface as a scan error so the
    // store keeps the previous projection instead of caching an empty one.
    if (isMissingFsError(error)) {
      return []
    }
    throw error
  }
}

export async function getProcessedFileInfo(filePath: string): Promise<DevinUsageProcessedFile> {
  const fileStat = await wslGatedStat(filePath, 'scan')
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size
  }
}

/**
 * Observe the sessions.db a transcripts dir is indexed by, so a db-only change
 * (working_directory edit, hidden toggle) re-attributes cached files. Only a
 * genuinely missing db is 'none' — every other failure must retry next scan.
 */
export async function observeDevinSessionsDb(
  transcriptsDir: string
): Promise<SessionSidecarObservation> {
  const dbPath = join(transcriptsDir, '..', 'sessions.db')
  // Why wal first: WAL-mode commits land in sessions.db-wal while the db's own
  // stat stays put until checkpoint, so the wal is the fresher signal — same
  // rule the AI Vault applies via devinSessionsDbDependencyPath.
  try {
    const walPath = `${dbPath}-wal`
    const walStat = await wslGatedStat(walPath, 'scan')
    if (walStat.isFile()) {
      return { path: walPath, mtimeMs: walStat.mtimeMs, sizeBytes: walStat.size }
    }
  } catch (error) {
    if (!isMissingFsError(error)) {
      return 'unknown'
    }
  }
  try {
    const dbStat = await wslGatedStat(dbPath, 'scan')
    return dbStat.isFile()
      ? { path: dbPath, mtimeMs: dbStat.mtimeMs, sizeBytes: dbStat.size }
      : 'none'
  } catch (error) {
    return isMissingFsError(error) ? 'none' : 'unknown'
  }
}

function isMissingFsError(error: unknown): boolean {
  if (error instanceof WslTranscriptFsError) {
    return false
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

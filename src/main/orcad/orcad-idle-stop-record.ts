/**
 * The record that tells a clean idle stop apart from a crash. Written just before an idle
 * stop and discarded if that stop fails; the next start reports it once and removes it, so a
 * later crash never inherits it.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  ORCAD_IDLE_STOP_RECORD_FILENAME,
  OrcadIdleStopRecordSchema,
  type OrcadIdleStopRecord
} from '../../shared/orcad-idle-exit'
import type { OrcadIdleExitEvidence } from './orcad-idle-exit-monitor'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

const RECORD_MAX_BYTES = 16 * 1024

export function orcadIdleStopRecordPath(userDataPath: string): string {
  return join(userDataPath, ORCAD_IDLE_STOP_RECORD_FILENAME)
}

export function writeOrcadIdleStopRecord(
  userDataPath: string,
  evidence: OrcadIdleExitEvidence,
  version: string
): void {
  const record: OrcadIdleStopRecord = {
    schemaVersion: 1,
    kind: 'orcad_idle_stop',
    pid: process.pid,
    version,
    quietSince: new Date(evidence.quietSince).toISOString(),
    stoppedAt: new Date(evidence.stoppedAt).toISOString(),
    idleTimeoutMs: evidence.timeoutMs
  }
  if (!writeDurableSecureJsonFile(orcadIdleStopRecordPath(userDataPath), record)) {
    throw new Error('orcad_idle_stop_record_permissions_unconfirmed')
  }
}

/** The previous run's idle stop, or null when it ended any other way (or never ran). */
export function consumeOrcadIdleStopRecord(userDataPath: string): OrcadIdleStopRecord | null {
  const path = orcadIdleStopRecordPath(userDataPath)
  let record: OrcadIdleStopRecord | null = null
  try {
    const raw = readNodeFileSyncWithinLimit(path, RECORD_MAX_BYTES).buffer.toString('utf8')
    record = OrcadIdleStopRecordSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    console.error('[orcad] ignoring an unreadable idle-stop record:', error)
  }
  rmSync(path, { force: true })
  return record
}

export function discardOrcadIdleStopRecord(userDataPath: string): void {
  rmSync(orcadIdleStopRecordPath(userDataPath), { force: true })
}

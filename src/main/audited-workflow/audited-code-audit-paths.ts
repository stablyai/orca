// Run-scoped paths for a Codex code audit (Phase 7).
//
// Every path is derived from the TRUSTED userData root plus the canonical run id,
// and from nothing else. The renderer supplies only a taskId, so it can never
// influence where Codex writes its result — and because the path is run-scoped, a
// stale file from a previous attempt can never satisfy a later run's read.
import { join } from 'node:path'

export function getCodeAuditRunDir(userDataPath: string, runId: string): string {
  return join(userDataPath, 'audited-workflow', 'code-audits', runId)
}

export function getCodeAuditLastMessagePath(userDataPath: string, runId: string): string {
  return join(getCodeAuditRunDir(userDataPath, runId), 'last-message.txt')
}

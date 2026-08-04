// Run-scoped paths for a Codex plan review.
//
// Every path here is derived from the TRUSTED userData root plus the canonical
// run id, and from nothing else. The renderer supplies only a taskId, so it can
// never influence where Codex writes its result — and because the path is
// run-scoped, a stale file from a previous attempt can never satisfy a later
// run's read.
import { join } from 'node:path'

export function getPlanReviewRunDir(userDataPath: string, runId: string): string {
  return join(userDataPath, 'audited-workflow', 'reviews', runId)
}

export function getLastMessagePath(userDataPath: string, runId: string): string {
  return join(getPlanReviewRunDir(userDataPath, runId), 'last-message.txt')
}

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ORCA_OMP_FORCE_NEW_SESSION_ENV,
  ORCA_OMP_FRESH_SESSION_DIR_ENV
} from '../../shared/omp-fresh-session-env'

function stableScopeSegment(scope: { worktreeId?: string | null; cwd?: string | null }): string {
  const source = scope.worktreeId?.trim() || scope.cwd?.trim() || 'unknown-worktree'
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

function resolveOmpSourceAgentDir(env: Record<string, string>): string {
  return (
    env.ORCA_OMP_SOURCE_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent')
  )
}

export function applyOmpFreshSessionDirEnv(
  env: Record<string, string>,
  scope: { worktreeId?: string | null; cwd?: string | null }
): void {
  if (env[ORCA_OMP_FORCE_NEW_SESSION_ENV] !== '1' || env[ORCA_OMP_FRESH_SESSION_DIR_ENV]) {
    return
  }
  env[ORCA_OMP_FRESH_SESSION_DIR_ENV] = join(
    resolveOmpSourceAgentDir(env),
    'sessions',
    'orca-worktrees',
    stableScopeSegment(scope)
  )
}

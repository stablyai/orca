import { resolve } from 'node:path'
import { getAiVaultWslHomeDirs } from '../ai-vault/cached-session-list'
import { listClaudeSubagentSessions } from '../ai-vault/session-scanner-claude-subagents'
import { listOmpSubagentSessions } from '../ai-vault/session-scanner-omp-subagent-listing'
import { claudeProjectsRootDirs, ompSessionsRootDirs } from '../ai-vault/session-scanner-roots'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'

// Provider-gated: only Claude and OMP materialize Task subagent transcripts as
// sibling files today; other agents resolve to an empty list.
export async function listAiVaultSubagentSessions(
  args?: AiVaultSubagentListArgs
): Promise<AiVaultSubagentListResult> {
  // IPC payloads are untyped at runtime; malformed input resolves empty like
  // every other rejected input instead of throwing.
  if (
    !args ||
    (args.agent !== 'claude' && args.agent !== 'omp') ||
    typeof args.parentFilePath !== 'string' ||
    !args.parentFilePath.trim()
  ) {
    return { sessions: [], issues: [] }
  }
  // Why: subagent transcripts are read from the local filesystem. The UI
  // skips remote sessions (their transcripts live on the remote host); return
  // empty defensively rather than reading local paths for a remote session.
  if ((args.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID) {
    return { sessions: [], issues: [] }
  }
  // Why: the path is renderer-supplied; only list files under the agent's
  // known sessions roots so a crafted path can't readdir/preview arbitrary
  // dirs.
  // resolve() collapses `..` segments first — isPathInsideOrEqual compares
  // textually and would otherwise pass `<root>/../../etc/x.jsonl`.
  const parentFilePath = resolve(args.parentFilePath)
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const roots =
    args.agent === 'claude'
      ? claudeProjectsRootDirs({ wslHomeDirs })
      : ompSessionsRootDirs({ wslHomeDirs })
  if (!roots.some((root) => isPathInsideOrEqual(resolve(root), parentFilePath))) {
    return { sessions: [], issues: [] }
  }
  return args.agent === 'claude'
    ? listClaudeSubagentSessions({ parentFilePath })
    : listOmpSubagentSessions({ parentFilePath })
}

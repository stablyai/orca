import { resolve } from 'node:path'
import {
  codexSessionsDirs,
  configuredAdditionalCodexHomePaths,
  getAiVaultWslHomeDirs
} from '../../ai-vault/cached-session-list'
import { listAiVaultSubagentSessionsInBackground } from '../../ai-vault/scan-service/session-scanner-background'
import { claudeProjectsRootDirs } from '../../ai-vault/session-scanner-roots'
import {
  sessionRowRootDirs,
  AI_VAULT_AGENT_SOURCES
} from '../../ai-vault/session-scanner-agent-sources'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'

// Only Claude and OMP currently store Task subagents as sibling transcripts.
export async function listAiVaultSubagentSessions(
  args?: AiVaultSubagentListArgs
): Promise<AiVaultSubagentListResult> {
  // Untyped malformed IPC input follows the empty-result rejection contract.
  if (
    !args ||
    (args.agent !== 'claude' && args.agent !== 'omp' && args.agent !== 'codex') ||
    typeof args.parentFilePath !== 'string' ||
    !args.parentFilePath.trim()
  ) {
    return { sessions: [], issues: [] }
  }
  // Remote transcripts must never resolve through the local filesystem.
  if ((args.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID) {
    return { sessions: [], issues: [] }
  }
  // Resolve .. before textual root checks so renderer paths cannot escape the agent's session roots.
  const parentFilePath = resolve(args.parentFilePath)
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const roots =
    args.agent === 'claude'
      ? claudeProjectsRootDirs({ wslHomeDirs })
      : args.agent === 'codex'
        ? // Containment only needs configured homes; the running-distro probe stays with full scans.
          AI_VAULT_AGENT_SOURCES.codex!.rootDirs(
            {
              additionalCodexSessionsDirs: codexSessionsDirs(configuredAdditionalCodexHomePaths())
            },
            wslHomeDirs
          )
        : sessionRowRootDirs('omp', {}, wslHomeDirs)
  const sessionsRoot = roots.find((root) => isPathInsideOrEqual(resolve(root), parentFilePath))
  if (!sessionsRoot) {
    return { sessions: [], issues: [] }
  }
  return listAiVaultSubagentSessionsInBackground({
    agent: args.agent,
    parentFilePath,
    ...(args.agent === 'codex' ? { sessionsRoot } : {})
  })
}

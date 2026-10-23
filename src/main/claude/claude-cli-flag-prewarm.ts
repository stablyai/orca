// Asks the Claude CLI for its version when native chat starts, so a chat's launch usually finds the
// answer already known instead of waiting on a probe of a cold binary.

import { homedir } from 'node:os'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { ClaudeCliFlagSupport } from './claude-cli-flag-support'
import {
  claudeProbeEnv,
  resolveClaudeChildEnvSources,
  type ClaudeEnvDeps
} from './claude-structured-child-env'

// Why a few: each is one short `--version` at startup; enough for the chats the user has open.
const MAX_PREWARMED_FOLDERS = 4

/**
 * Probes in the home folder, which loads the binary from a cold disk, and in the folder of each open
 * Claude chat pinned to one (the probe answer is per folder: a version manager's shim can pick a
 * different CLI per project). Never resolves a workspace or lists worktrees, and never throws.
 */
export async function prewarmClaudeCliFlags(
  deps: ClaudeEnvDeps & {
    cliFlags: Pick<ClaudeCliFlagSupport, 'prewarm'>
    store: Pick<AgentSessionRecordStore, 'listVisibleSessionIds' | 'getRecord'>
  }
): Promise<void> {
  try {
    const sources = await resolveClaudeChildEnvSources(deps)
    const folders = new Set([homedir()])
    for (const sessionId of deps.store.listVisibleSessionIds()) {
      if (folders.size >= MAX_PREWARMED_FOLDERS) {
        break
      }
      const record = deps.store.getRecord(sessionId)
      if (
        record?.provider === 'claude' &&
        record.location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
        record.location.wslDistro === null &&
        record.launchDirectory
      ) {
        folders.add(record.launchDirectory)
      }
    }
    const env = claudeProbeEnv(sources)
    for (const cwd of folders) {
      deps.cliFlags.prewarm({ command: sources.command, cwd, env })
    }
  } catch {
    // A launch probes for itself; this only saves it the wait.
  }
}

import { homedir } from 'node:os'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { ClaudeCliFlagSupport } from './claude-cli-flag-support'
import {
  claudeProbeEnv,
  resolveClaudeChildEnvSources,
  type ClaudeEnvDeps
} from './claude-structured-child-env'

const MAX_PREWARMED_FOLDERS = 4

// Probe home and stored local chat folders; cwd-specific shims may select different CLIs.
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

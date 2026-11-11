import type {
  AgentConfigSyncStatus,
  CloudAgentConfigSyncPreferences
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'

export const MAX_EXCLUDED = 1024

// Off until the user turns it on: a cloud workspace can be shared with a team, and skills are
// the user's own prompts. One switch in Settings is the consent.
export const DEFAULT_PREFERENCES: CloudAgentConfigSyncPreferences = {
  autoSync: false,
  shareAcrossAgents: false,
  excluded: []
}

export class RuntimeCallError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined
  ) {
    super(message)
  }
}

export function errorCode(error: unknown): AgentConfigSyncStatus['error'] {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'method_not_found') {
    return 'host-outdated'
  }
  return /unavailable|timeout|unreachable/.test(code) ? 'host-unreachable' : 'failed'
}

/** Repo-relative files git tracks under the project agent folders. */
export async function trackedAgentConfigPaths(repoPath: string): Promise<ReadonlySet<string>> {
  const { stdout } = await gitExecFileAsync(
    ['ls-files', '-z', '--', '.claude/skills', '.claude/commands', '.agents/skills'],
    { cwd: repoPath, timeout: 10_000 }
  )
  return new Set(stdout.split('\0').filter(Boolean))
}

export function parsePreferences(text: string): CloudAgentConfigSyncPreferences {
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_PREFERENCES, excluded: [] }
  }
  return {
    autoSync: 'autoSync' in raw && raw.autoSync === true,
    shareAcrossAgents: 'shareAcrossAgents' in raw && raw.shareAcrossAgents === true,
    excluded:
      'excluded' in raw && Array.isArray(raw.excluded)
        ? raw.excluded
            .filter((key): key is string => typeof key === 'string' && key.length <= 300)
            .slice(0, MAX_EXCLUDED)
        : []
  }
}

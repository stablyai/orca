import { agentTokenUsageSchema } from '../../shared/telemetry-agent-token-usage-schema'
import { claudeProfileTranscriptDirs } from '../claude-usage/transcript-file-discovery'
import { loadKnownUsageWorktreesByRepo } from '../usage/worktree-attribution/usage-worktree-metadata'
import { isTelemetryEnabled, track } from '../telemetry/client'
import type { Store } from '../persistence/loading-store/store'

export function createBackendDesktopCapabilities(
  store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>
): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    if (method === 'usage.catalog') {
      const repos = store.getRepos()
      return {
        repoIds: repos.map((repo) => repo.id),
        worktreesByRepo: [...loadKnownUsageWorktreesByRepo(store, repos)]
      }
    }
    if (method === 'usage.claudeProfileDirs') {
      return claudeProfileTranscriptDirs()
    }
    if (method === 'usage.telemetry.enabled') {
      return isTelemetryEnabled()
    }
    if (method === 'usage.telemetry.capture') {
      return track('agent_token_usage', agentTokenUsageSchema.parse(params))
    }
    throw new Error('This desktop capability is not supported.')
  }
}

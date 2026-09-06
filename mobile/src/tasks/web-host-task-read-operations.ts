import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { normalizeWorkspaceAgent } from './workspace-agent-selection'
import type { HostTaskBootstrap, HostTaskReadOperations } from './host-task-read-operations'

export function webHostTaskReadOperations(client: MobileWebBridgeClient): HostTaskReadOperations {
  return {
    async bootstrap() {
      return webBootstrap(await client.task.bootstrap())
    },
    async listRepositories() {
      return (await client.task.repositories()).repositories
    },
    loadLinearContext: () => client.task.linearContext(),
    async resolveGitHubRepoSlug(repoId) {
      return (await client.task.resolveRepoSlug({ repoId })).repository
    }
  }
}

function webBootstrap(
  bootstrap: Awaited<ReturnType<MobileWebBridgeClient['task']['bootstrap']>>
): HostTaskBootstrap {
  const defaultTuiAgent = normalizeWorkspaceAgent(bootstrap.settings.defaultTuiAgent)
  return {
    ...bootstrap,
    settings: {
      ...bootstrap.settings,
      defaultTuiAgent,
      disabledTuiAgents: bootstrap.settings.disabledTuiAgents?.flatMap((agent) => {
        const normalized = normalizeWorkspaceAgent(agent)
        return normalized && normalized !== 'blank' ? [normalized as TuiAgent] : []
      })
    }
  }
}

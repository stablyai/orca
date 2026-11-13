import { applyProjectAgentLaunchDefaults } from '../../../shared/agent-launch/choices/project-agent-launch-defaults'
import { structuredLaunchSeedOptions } from '../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveWorktreeHostRouting } from '../workspaces/catalog/worktree-launch-host-repo'

export function structuredSessionProjectSeedOptions(
  store: Pick<RuntimeStore, 'getRepos' | 'getSettings'>,
  agent: StructuredAgentId,
  worktree?: Pick<Worktree, 'repoId' | 'hostId'>,
  resume = false
) {
  const settings = store.getSettings()
  // A resume keeps the provider session's own model, so saved choices never seed it.
  if (resume) {
    return structuredLaunchSeedOptions({ ...settings, agentLaunchChoices: undefined }, agent)
  }
  const routing = worktree ? resolveWorktreeHostRouting(store.getRepos(), worktree) : undefined
  const defaults = routing?.kind === 'resolved' ? routing.repo?.agentLaunchDefaults : undefined
  return structuredLaunchSeedOptions(applyProjectAgentLaunchDefaults(settings, defaults), agent)
}

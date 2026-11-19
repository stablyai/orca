import {
  loadMobileAgentLaunchContext,
  newTabAgentOptionsFrom,
  hostRefusesOtherRuntimeWorkspace
} from '../session/agent-launch/mobile-new-tab-agent-loader'
import { refreshMobileHistorySession } from './refresh-mobile-history-session'
import { loadMobileHistoryContinuationTarget } from './mobile-history-session-continuation'

export async function loadMobileHistoryHandoffAgents(
  args: Parameters<typeof loadMobileHistoryContinuationTarget>[0]
) {
  const session = await refreshMobileHistorySession(args.client, args.session)
  args.assertCurrentOwner()
  const { target, host } = await loadMobileHistoryContinuationTarget({ ...args, session })
  const context = await loadMobileAgentLaunchContext({
    client: args.client,
    worktreeId: target.worktreeId,
    hostRefusesOtherRuntime: hostRefusesOtherRuntimeWorkspace(host.capabilities)
  })
  args.assertCurrentOwner()
  return {
    worktreeId: target.worktreeId,
    agents: newTabAgentOptionsFrom(context.settings, context.detectedAgents)
  }
}

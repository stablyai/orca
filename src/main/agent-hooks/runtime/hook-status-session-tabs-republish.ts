import type { TabListRef } from '../../bots/team-share/teammate-rules'
import type { AgentHookServer } from '../server/agent-hook-server'

type StatusRowIdentity = { paneKey: string; worktreeId?: string; terminalHandle?: string }

type SessionTabsRepublisher = {
  getStatusTabList(identity: StatusRowIdentity): TabListRef | null
  scheduleSessionTabListAgentStatusHeartbeat(list: TabListRef): void
  touchSessionTabList(list: TabListRef): void
}

type StatusStore = Pick<AgentHookServer, 'subscribeStatusFreshness' | 'subscribeStatusRowMutations'>

/** Status-only changes need session.tabs republishing even without PTY activity, in the list the
 *  row's chat or terminal is in (`getStatusTabList`); a row no record places reaches no list. */
export function installHookStatusSessionTabsRepublish(
  statusStore: StatusStore,
  getRuntime: () => SessionTabsRepublisher | null | undefined
): () => void {
  const unsubscribeMutations = statusStore.subscribeStatusRowMutations((mutation) => {
    const runtime = getRuntime()
    if (!runtime) {
      return
    }
    const lists = new Map<string, TabListRef>()
    for (const identity of [mutation.before, mutation.after]) {
      const list = identity ? runtime.getStatusTabList(identity) : null
      if (list) {
        lists.set(`${list.holder ?? 'host'}\0${list.workspaceId}`, list)
      }
    }
    for (const list of lists.values()) {
      runtime.touchSessionTabList(list)
    }
  })
  const unsubscribeFreshness = statusStore.subscribeStatusFreshness((status) => {
    const runtime = getRuntime()
    const list = runtime?.getStatusTabList(status)
    if (runtime && list) {
      runtime.scheduleSessionTabListAgentStatusHeartbeat(list)
    }
  })
  return () => {
    unsubscribeMutations()
    unsubscribeFreshness()
  }
}

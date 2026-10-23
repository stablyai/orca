import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { agentHookServer } from '../../agent-hooks/server'
import {
  collectLiveLeafHolders,
  pickLiveLeafOwnerTabId
} from '../terminal-topology/terminal-leaf-live-owner'
import type { StoreRuntimeState } from './store-runtime-state'

/**
 * A hook key whose alias was evicted still names a leaf that main's layouts can place.
 * While a durable mutation is unsettled it can still roll back, and a fallback alias or row cached
 * from it would outlive it, so the resolver reads the topology committed before that mutation began.
 */
export function installLiveLeafOwnerResolver(
  runtime: Pick<
    StoreRuntimeState,
    'uncommittedDurableMutations' | 'committedLeafHolders' | 'captureCommittedLeafHolders'
  >,
  terminalSessions: () => readonly WorkspaceSessionState[]
): void {
  runtime.captureCommittedLeafHolders = () => collectLiveLeafHolders(terminalSessions())
  agentHookServer.setLiveLeafOwnerResolver((tabId, leafId) => {
    const holders =
      runtime.uncommittedDurableMutations > 0
        ? runtime.committedLeafHolders
        : collectLiveLeafHolders(terminalSessions())
    return holders ? pickLiveLeafOwnerTabId(holders, tabId, leafId) : tabId
  })
}

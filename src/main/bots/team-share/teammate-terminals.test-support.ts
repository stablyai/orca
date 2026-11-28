// The owner's and a teammate's terminals in a shared agent's Home, and the hook rows their agents
// report, for the teammate-terminal tests.
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentHookStatusRowMutation } from '../../agent-hooks/server/server-types'
import type { AgentStatusStoreView } from '../../runtime/sidebar-inputs/workspace-facts/workspace-activity-facts-producer'
import { openTerminal, startTerminalsOnTheHost, type rig } from './teammate-tabs.test-support'

export type Rig = Awaited<ReturnType<typeof rig>>

export /** The owner's and Mate's terminals in the Home, opened before the owner's window is watched. */
async function bothTerminals(r: Rig) {
  startTerminalsOnTheHost(r)
  const owners = await openTerminal(r, 'owner-desk')
  const mates = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  return { owners, mates }
}

export /** The hook server's status rows, as the runtime's transitions read them. */
function hookStatusStore(r: Rig) {
  const rows = new Map<string, AgentStatusIpcPayload>()
  const listeners = new Set<(mutation: AgentHookStatusRowMutation) => void>()
  let receivedAt = Date.now()
  const store: AgentStatusStoreView = {
    getStatusSnapshot: () => [...rows.values()],
    getStatusSnapshotForPane: (paneKey) => (rows.has(paneKey) ? [rows.get(paneKey)!] : []),
    subscribeStatusRowMutations: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeStatusFreshness: () => () => {}
  }
  const detach = r.runtime.attachAgentStatusStore(store)
  return {
    report: (row: { paneKey: string; worktreeId: string; state: 'working' | 'done' }) => {
      const before = rows.get(row.paneKey) ?? null
      receivedAt += 1
      const after: AgentStatusIpcPayload = {
        ...row,
        agentType: 'claude',
        prompt: '',
        connectionId: null,
        stateStartedAt: receivedAt,
        receivedAt
      }
      rows.set(row.paneKey, after)
      for (const listener of listeners) {
        listener({ before, after })
      }
    },
    detach
  }
}

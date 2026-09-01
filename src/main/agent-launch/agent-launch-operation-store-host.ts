// Host-wide singleton launch-operation store. Paired with the singleton launch
// boundary (agent-launch-boundary-host.ts): the boundary owns admission, this
// owns the durable idempotency ledger + private pending-snapshot attribution.
// One instance per host so retry idempotency and crash reconciliation see every
// creation attempt. Durable persistence (rehydrate on startup) attaches with the
// reconciliation work; the in-memory instance backs the create/retry path.

import { AgentLaunchOperationStore } from './agent-launch-operation-store'

let store: AgentLaunchOperationStore | null = null

export function getHostAgentLaunchOperationStore(): AgentLaunchOperationStore {
  if (!store) {
    store = new AgentLaunchOperationStore()
  }
  return store
}

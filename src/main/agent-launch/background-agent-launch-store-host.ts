// Host-wide singleton generic background-attempt store. One instance per host so
// every background launch producer records its attempt and the reconciler/
// tombstone index read the same private records. Durable persistence attaches at
// boot; the in-memory instance backs create/settle/forget before that.

import { BackgroundAgentLaunchStore } from './background-agent-launch-store'

let store: BackgroundAgentLaunchStore | null = null

export function getHostBackgroundAgentLaunchStore(): BackgroundAgentLaunchStore {
  if (!store) {
    store = new BackgroundAgentLaunchStore()
  }
  return store
}

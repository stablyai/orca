// Host-wide singleton session record store. One instance per host so every launch
// surface registers attribution and every resume/fork resolves against the same
// private records. Durable persistence attaches at boot; the in-memory instance
// backs registration/bind/resolve before that.

import { AgentSessionRecordStore } from './agent-session-record-store'

let store: AgentSessionRecordStore | null = null

export function getHostAgentSessionRecordStore(): AgentSessionRecordStore {
  if (!store) {
    store = new AgentSessionRecordStore()
  }
  return store
}

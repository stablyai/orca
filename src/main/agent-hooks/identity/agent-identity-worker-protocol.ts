// Electron-free: shared by the identity worker and its hook-server client.
import type { AgentProviderKey } from './agent-provider-key'

export type AgentIdentityWorkerRequest =
  | { id: number; kind: 'identify'; path: string; key: AgentProviderKey }
  | { id: number; kind: 'has'; path: string; orcaSessionId: string }

/** `identify` answers the committed id, or null for an unlinked key in a read-only file. */
export type AgentIdentityWorkerResponse =
  | { id: number; ok: true; value: string | null | boolean }
  | { id: number; ok: false; error: string }

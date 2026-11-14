// Electron-free: shared by the identity worker and its hook-server client.
import type { AgentProviderKey } from './agent-provider-key'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

export type AgentIdentityWorkerRequest =
  | { id: number; kind: 'identify'; path: string; key: AgentProviderKey }
  | { id: number; kind: 'has'; path: string; orcaSessionId: string }
  | { id: number; kind: 'providerKeyOf'; path: string; orcaSessionId: string }
  | { id: number; kind: 'idsOfProviderSession'; path: string; providerSessionId: string }
  | { id: number; kind: 'idsOfKeys'; path: string; keys: AgentProviderKey[] }

/** A reverse lookup this file can't serve by index: a newer build's read-only file without one.
 *  Not a store failure, so it neither closes the store nor starts the failure backoff. */
export const REVERSE_LOOKUP_UNAVAILABLE = { unavailable: 'reverse-index' } as const
export type ReverseLookupUnavailable = typeof REVERSE_LOOKUP_UNAVAILABLE

export function isReverseLookupUnavailable(value: unknown): value is ReverseLookupUnavailable {
  return isRecord(value) && value.unavailable === 'reverse-index'
}

/** `identify` answers the committed id, or null for an unlinked key in a read-only file;
 *  `idsOfKeys` answers each key's linked id in order, '' for none, and links nothing. */
export type AgentIdentityWorkerResponse =
  | {
      id: number
      ok: true
      value: string | null | boolean | AgentProviderKey | string[] | ReverseLookupUnavailable
    }
  | { id: number; ok: false; error: string }

/**
 * Agent Consent Store (P1-1)
 *
 * On-disk store of user decisions about which agent types may message which
 * other agent types through the P0-2 broker
 * (src/main/runtime/agent-message-broker.ts).
 *
 * Storage convention: this follows the same pattern as the existing
 * DeviceRegistry (src/main/runtime/device-registry.ts) — a single JSON file
 * in the Electron userData directory, written through the shared
 * secure-file helpers (src/shared/secure-file.ts: writeSecureJsonFile),
 * which harden permissions (chmod 0600 on POSIX, ACL-restricted on Windows)
 * and publish via tmp-file-then-rename so a crash mid-write can never leave
 * a torn file. All records are read into memory once in the constructor;
 * record()/query() afterwards never touch disk on the read side, which
 * matters because query() runs synchronously inside
 * AgentMessageBroker.send() on every message.
 *
 * This is deliberately a *separate* small file rather than a new field
 * grafted onto orca-data.json (the store in src/main/persistence.ts that
 * plugin consent piggybacks on via `settings.pluginConsents` — see
 * src/main/plugins/plugin-enablement.ts). That Store class is ~7800 lines
 * with its own schema-versioning and migration discipline covering
 * worktrees, sessions, and dozens of unrelated settings; agent-to-agent
 * messaging consent has no relationship to any of that state and needs no
 * migration machinery of its own. Structurally this instead mirrors
 * DeviceRegistry — and, for that matter, the P0-1/P0-2 in-memory registries
 * this store sits beside — down to the load-once-into-memory,
 * write-through-on-mutation shape.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { getCanonicalUserDataPath } from '../persistence'
import { agentConsentPairKey } from '../../shared/agent-consent'
import type {
  AgentConsentQueryResult,
  AgentConsentRecord,
  AgentConsentRecordRequest
} from '../../shared/agent-consent'

export const AGENT_CONSENT_STORE_FILENAME = 'orca-agent-consent.json'

function isAgentConsentRecord(value: unknown): value is AgentConsentRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<AgentConsentRecord>
  return (
    typeof record.sourceAgentType === 'string' &&
    record.sourceAgentType.length > 0 &&
    typeof record.targetAgentType === 'string' &&
    record.targetAgentType.length > 0 &&
    (record.decision === 'allow' || record.decision === 'deny') &&
    typeof record.decidedAt === 'number' &&
    Number.isFinite(record.decidedAt)
  )
}

/**
 * On-disk + in-memory store of agent-to-agent consent decisions.
 * Thread-safety: assumes single-threaded Node.js event loop usage, same as
 * AgentRegistry/AgentMessageBroker.
 */
export class AgentConsentStore {
  private readonly filePath: string
  private records: Map<string, AgentConsentRecord>

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, AGENT_CONSENT_STORE_FILENAME)
    this.records = new Map()
    this.load()
  }

  /**
   * Record a user's decision for (sourceAgentType -> targetAgentType).
   * Overwrites any prior decision for the same pair. Persists before
   * updating memory (matching DeviceRegistry.save()'s ordering) so a failed
   * write cannot leave a decision live in memory that never reached disk.
   */
  record(request: AgentConsentRecordRequest): AgentConsentRecord {
    const entry: AgentConsentRecord = {
      sourceAgentType: request.sourceAgentType,
      targetAgentType: request.targetAgentType,
      decision: request.decision,
      decidedAt: Date.now()
    }
    const nextRecords = new Map(this.records)
    nextRecords.set(agentConsentPairKey(entry.sourceAgentType, entry.targetAgentType), entry)
    this.save(nextRecords)
    this.records = nextRecords
    return entry
  }

  /**
   * Query the decision for (sourceAgentType -> targetAgentType).
   * Pure in-memory read — safe to call on every message send.
   */
  query(sourceAgentType: string, targetAgentType: string): AgentConsentQueryResult {
    const entry = this.records.get(agentConsentPairKey(sourceAgentType, targetAgentType))
    return entry?.decision ?? 'unknown'
  }

  /** All recorded decisions. Useful for a future consent UI (P1-2) and for
   *  tests. */
  list(): readonly AgentConsentRecord[] {
    return [...this.records.values()]
  }

  /** Clear all in-memory decisions. Does not touch disk — useful for
   *  testing. */
  clear(): void {
    this.records.clear()
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.records = new Map()
      return
    }
    try {
      hardenExistingSecureFile(this.filePath)
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      // Why: never trust raw disk data — a hand-edited or corrupted file
      // must degrade to "no decisions recorded" (deny-by-default via
      // query()'s 'unknown' fallback) rather than crash the store or, worse,
      // be coerced into a decision nobody actually made.
      const list = Array.isArray(parsed) ? parsed.filter(isAgentConsentRecord) : []
      this.records = new Map(
        list.map((entry) => [
          agentConsentPairKey(entry.sourceAgentType, entry.targetAgentType),
          entry
        ])
      )
    } catch {
      this.records = new Map()
    }
  }

  private save(records: Map<string, AgentConsentRecord>): void {
    writeSecureJsonFile(this.filePath, [...records.values()])
  }
}

/**
 * Global singleton instance of the agent consent store, mirroring the
 * getGlobalAgentRegistry()/getGlobalAgentMessageBroker() pattern in
 * src/main/runtime/agent-registry.ts and
 * src/main/runtime/agent-message-broker.ts. Lazily constructed against the
 * real Electron userData directory (src/main/persistence.ts's
 * getCanonicalUserDataPath()) on first use in production; tests inject a
 * store pointed at a temp directory via setGlobalAgentConsentStore() before
 * ever exercising the lazy path, so this getter's Electron dependency is
 * never reached under vitest.
 */
let globalAgentConsentStore: AgentConsentStore | null = null

export function getGlobalAgentConsentStore(): AgentConsentStore {
  if (!globalAgentConsentStore) {
    globalAgentConsentStore = new AgentConsentStore(getCanonicalUserDataPath())
  }
  return globalAgentConsentStore
}

/**
 * Set the global agent consent store (mainly for testing).
 */
export function setGlobalAgentConsentStore(store: AgentConsentStore | null): void {
  globalAgentConsentStore = store
}

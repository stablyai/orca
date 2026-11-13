import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../../worker-threads/worker-thread-request-queue'
import type {
  WorkerRequestTransport,
  WorkerThreadFactory
} from '../../worker-threads/worker-thread-transport'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentProviderKey } from './agent-provider-key'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type {
  AgentIdentityWorkerRequest,
  AgentIdentityWorkerResponse
} from './agent-identity-worker-protocol'

const WORKER_ENTRY_FILENAME = 'agent-identity-worker-entry.js'
// One operation's budget from dispatch: a cold open (version read, WAL setup, DDL) plus a lock wait.
const OPERATION_TIMEOUT_MS = 10_000
// Identity work comes in bursts (hydration, new agents); an idle worker is released.
const IDLE_TEARDOWN_MS = 60_000

/** `undefined`: the worker could not answer (spawn, open, lock, timeout); never a settled miss. */
export type AgentIdentityLookup = { id: OrcaSessionId | null } | undefined

export type AgentIdentityClient = {
  identify(path: string, key: AgentProviderKey): Promise<AgentIdentityLookup>
  has(path: string, orcaSessionId: string): Promise<boolean | undefined>
  /** `{ key: null }`: this host never linked `orcaSessionId`; undefined: no answer now. */
  providerKeyOf(
    path: string,
    orcaSessionId: string
  ): Promise<{ key: AgentProviderKey | null } | undefined>
  idsOfProviderSession(
    path: string,
    providerSessionId: string
  ): Promise<OrcaSessionId[] | undefined>
  /** Terminated but not yet exited: a replacement must wait for `retired()`. */
  readonly isRetiring: boolean
  retired(): Promise<void>
  dispose(): void
}

function spawnAgentIdentityWorker(): WorkerRequestTransport {
  // A missing entry fails the spawned worker, which the queue reports as unavailable.
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_ENTRY_FILENAME)
  )
}

/** The hook server's one identity worker: SQL never runs on its thread. */
export class AgentIdentityWorkerClient implements AgentIdentityClient {
  private readonly queue: WorkerThreadRequestQueue<
    AgentIdentityWorkerRequest,
    AgentIdentityWorkerResponse
  >

  constructor(factory: WorkerThreadFactory = spawnAgentIdentityWorker) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: 2,
      // A timed-out transaction can still be inside SQLite; never start a second worker beside it.
      awaitRetirement: true,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `Agent identity worker timed out after ${ms}ms`,
      describeExit: (code) => `Agent identity worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `Agent identity worker crashed repeatedly (${lastError})`,
      onUnavailable: (error) =>
        console.warn('[agent-hooks] agent identity worker unavailable:', error)
    })
  }

  async identify(path: string, key: AgentProviderKey): Promise<AgentIdentityLookup> {
    const value = await this.request((id) => ({ id, kind: 'identify', path, key }))
    if (value === null) {
      return { id: null }
    }
    return typeof value === 'string' && isOrcaSessionId(value) ? { id: value } : undefined
  }

  async has(path: string, orcaSessionId: string): Promise<boolean | undefined> {
    const value = await this.request((id) => ({ id, kind: 'has', path, orcaSessionId }))
    return typeof value === 'boolean' ? value : undefined
  }

  async providerKeyOf(
    path: string,
    orcaSessionId: string
  ): Promise<{ key: AgentProviderKey | null } | undefined> {
    const value = await this.request((id) => ({ id, kind: 'providerKeyOf', path, orcaSessionId }))
    if (value === null) {
      return { key: null }
    }
    return isProviderKey(value) ? { key: value } : undefined
  }

  async idsOfProviderSession(
    path: string,
    providerSessionId: string
  ): Promise<OrcaSessionId[] | undefined> {
    const value = await this.request((id) => ({
      id,
      kind: 'idsOfProviderSession',
      path,
      providerSessionId
    }))
    return Array.isArray(value) ? value.filter(isOrcaSessionId) : undefined
  }

  get isRetiring(): boolean {
    return this.queue.isRetiring
  }

  retired(): Promise<void> {
    return this.queue.retired()
  }

  dispose(): void {
    this.queue.dispose()
  }

  /** The owner sends one operation at a time, so its deadline is the operation's own, from
   *  dispatch; callers' waits are bounded by the owner, not here. */
  private async request(
    build: (id: number) => AgentIdentityWorkerRequest
  ): Promise<Extract<AgentIdentityWorkerResponse, { ok: true }>['value'] | undefined> {
    try {
      const response = await this.queue.dispatch(build, OPERATION_TIMEOUT_MS)
      if (!response.ok) {
        console.warn('[agent-hooks] agent identity lookup failed:', response.error)
        return undefined
      }
      return response.value
    } catch {
      return undefined
    }
  }
}

function isProviderKey(value: unknown): value is AgentProviderKey {
  return (
    isRecord(value) &&
    ['executionHost', 'wslDistro', 'agent', 'providerSessionId', 'locator'].every(
      (field) => typeof value[field] === 'string'
    )
  )
}

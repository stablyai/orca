// Where the structured agent-session wire becomes a live host on this runtime.
//
// Built on the first `agentSession.*` call rather than at startup: the record
// store and the journals live under the profile's user-data path, which is not
// final until Electron is ready, and a runtime that never serves a structured
// session should not pay for a store it will never read. The slot the RPC layer
// reads is module-level for the same reason the registry is — the runtime
// service is already far past its size budget.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionAdapterDeps
} from '../codex/codex-structured-session-adapter'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import { stopOrphanAgentSessionChildren } from './agent-session-orphan-child-reaper'
import {
  probeAgentSessionProcessIdentities,
  probeAgentSessionProcessIdentity,
  probeAgentSessionReservation
} from './agent-session-process-identity-probe'
import { findAgentSessionSpawnTokenProcesses } from './agent-session-spawn-token-process-scan'
import { readEchoedAgentSessionSpawnToken } from './agent-session-spawn-token-readback'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'

/** Sibling of the journal tree rather than inside it: one file adjudicates every
 *  session's lease, while a journal is per session. */
const RECORD_STORE_DIR_NAME = 'agent-sessions'

export function hasPersistedStructuredAgentSessionStore(
  stateDirectory: string,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  const filePath = agentSessionStorePath(join(stateDirectory, RECORD_STORE_DIR_NAME))
  return fileExists(filePath) || fileExists(`${filePath}.bak`)
}

export type StructuredAgentSessionRuntimeDeps = {
  /** Host state root. The record store and the journal tree both hang off it. */
  stateDirectory: string
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Provider transports are overridden only to drive the runtime against scripted children. */
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  resolveLaunchArgs?: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
  onError?: (input: { scope: string; error: unknown }) => void
  handoffTransport?: StructuredAgentSessionHandoffTransport
  reapOrphanChildren?: typeof stopOrphanAgentSessionChildren
}

type InstalledRuntime = {
  host: StructuredAgentSessionHost
  adapter: CodexStructuredSessionAdapter
}

let installing: Promise<InstalledRuntime> | null = null

export function ensureStructuredAgentSessionHost(
  deps: StructuredAgentSessionRuntimeDeps
): Promise<StructuredAgentSessionHost> {
  // A failed open must not poison the slot forever — the next call retries.
  installing ??= install(deps).catch((error) => {
    installing = null
    throw error
  })
  return installing.then((installed) => installed.host)
}

/** Drops the host and reaps every Codex child under it. Runtime teardown and
 *  test isolation take the same path, so neither can leave a live app-server. */
export async function stopStructuredAgentSessionRuntime(): Promise<void> {
  const pending = installing
  installing = null
  setStructuredAgentSessionHost(null)
  agentSessionPtyWriteGate.detachRecordLookup()
  if (!pending) {
    return
  }
  const installed = await pending.catch(() => null)
  if (!installed) {
    return
  }
  try {
    await installed.adapter.closeAll()
  } finally {
    await installed.host.flushAllStreamedEvents()
  }
}

async function install(deps: StructuredAgentSessionRuntimeDeps): Promise<InstalledRuntime> {
  const bootEnvironment = (deps.resolveEnvironment ?? resolveLoginShellEnvironment)()
  const resolveEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...(await bootEnvironment),
    ...(await deps.resolveLaunchEnv?.()),
    ...(await deps.resolveLaunchEnvOverlay?.()),
    ...deps.resolveCodexOverrides?.()
  })
  const store = await AgentSessionRecordStore.open({
    directory: join(deps.stateDirectory, RECORD_STORE_DIR_NAME),
    hostId: deps.hostId
  })
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => store.getRecord(sessionId))
  // Why: only the durable store can identify a provider child lost before record publication.
  void (deps.reapOrphanChildren ?? stopOrphanAgentSessionChildren)({ store }).catch((error) => {
    try {
      if (deps.onError) {
        deps.onError({ scope: 'agent-session-orphan-child-reaper', error })
      } else {
        console.error('[structured-agent-session] orphan reaper failed', error)
      }
    } catch (reportingError) {
      console.error(
        '[structured-agent-session] orphan reaper error reporting failed',
        reportingError
      )
    }
  })
  try {
    const codex = new CodexStructuredSessionAdapter({
      resolveLaunch: createCodexStructuredLaunchResolver({
        store,
        resolveWorkspacePath: deps.resolveWorkspacePath,
        resolveEnvironment,
        ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
      }),
      ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
      ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
    })
    const adapter = codex
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: deps.stateDirectory,
      claimKeyId: deps.claimKeyId,
      probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
      probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
      ...(deps.resolveLaunchArgs
        ? {
            resolveLaunchArgs: async (provider: AgentSessionRecord['provider']) =>
              await deps.resolveLaunchArgs!(provider)
          }
        : {}),
      onEventSinkError: ({ sessionId, error }) =>
        deps.onError?.({ scope: `structured-agent-session-journal:${sessionId}`, error }),
      persistTuiProviderHandle: async ({ sessionId, link, now }) => {
        await store.transitionHandoff(sessionId, (record) =>
          recordAgentSessionProviderHandle({ record, fence: record.lease.runtimeFence, link, now })
        )
      },
      ...(deps.handoffTransport ? { handoffTransport: deps.handoffTransport } : {})
    })
    setStructuredAgentSessionHost(host)
    return { host, adapter }
  } catch (error) {
    agentSessionPtyWriteGate.detachRecordLookup()
    throw error
  }
}

/**
 * The lease's only source of truth about a previous owner. Everything it cannot
 * answer PID-reuse-safely reports `indeterminate`. An exact owner stays fenced in `recovering`;
 * an ownerless, unattributable reservation enters `manual-recovery`.
 */
export function createStructuredAgentSessionOwnerProbe(
  hostId: string,
  probe = probeAgentSessionProcessIdentity,
  findSpawnTokenProcesses = findAgentSessionSpawnTokenProcesses
): (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe> {
  return async (record) => {
    const owner = record.lease.ownerProcess
    if (!owner) {
      if (record.lease.processlessAt !== undefined && record.lease.processlessAt !== null) {
        return { outcome: 'reservation-unused' }
      }
      const spawnToken = record.lease.reservedSpawnToken
      if (spawnToken === null) {
        if (record.lease.claimStatus === 'reserved') {
          return {
            outcome: 'indeterminate',
            reason: 'reservation recorded no spawn token to scan for'
          }
        }
        // The token is minted before the child and is the only thing a child could be carrying.
        // No owner and no token means nothing on any host can be holding this lease — answering
        // `indeterminate` here is what latches an already-free record into recovery forever.
        return { outcome: 'reservation-unused' }
      }
      // Freeing a reservation needs positive proof that nothing spawned under its token. The scan
      // answers null where the platform cannot read another process's environment.
      return probeAgentSessionReservation({
        spawnToken,
        findProcessesWithSpawnToken: (token) => findSpawnTokenProcesses(token),
        hasProviderActivitySinceReservation: async () =>
          agentSessionReservationTouchedProvider(record)
      })
    }
    if (owner.hostId !== hostId) {
      // Checking a remote host's pid against this machine's process table is
      // exactly how a live owner gets declared dead.
      return {
        outcome: 'indeterminate',
        reason: `owner runs on ${owner.hostId}, which this host cannot probe`
      }
    }
    // The env read-back answers on hosts that expose it and null elsewhere, giving the
    // probe a PID-reuse-safe element even when no start time was recorded.
    return probe({
      identity: owner,
      deps: { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken }
    })
  }
}

export function createStructuredAgentSessionOwnerProbes(
  hostId: string,
  probeMany: typeof probeAgentSessionProcessIdentities = probeAgentSessionProcessIdentities,
  probeOne = createStructuredAgentSessionOwnerProbe(hostId)
): (records: readonly AgentSessionRecord[]) => Promise<Map<string, AgentSessionOwnerProbe>> {
  return async (records) => {
    const results = new Map<string, AgentSessionOwnerProbe>()
    const localOwners: {
      record: AgentSessionRecord
      owner: NonNullable<AgentSessionRecord['lease']['ownerProcess']>
    }[] = []
    for (const record of records) {
      const owner = record.lease.ownerProcess
      if (owner?.hostId === hostId) {
        localOwners.push({ record, owner })
      } else {
        results.set(record.sessionId, await probeOne(record))
      }
    }
    const probes = await probeMany({
      identities: localOwners.map(({ owner }) => owner),
      deps: { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken }
    })
    for (const [index, { record }] of localOwners.entries()) {
      results.set(
        record.sessionId,
        probes[index] ?? { outcome: 'indeterminate', reason: 'owner probe returned no result' }
      )
    }
    return results
  }
}

/**
 * The only provider-side trace a reservation can leave in its own record: a handle link minted at
 * this fence. `proveAgentSessionOwner` refuses to append one before an identity is committed, so a
 * link at the reservation's fence means a child got far enough to resume the provider thread. It
 * cannot see activity the child produced without proving a handle, which is why it is paired with
 * the token scan rather than trusted alone.
 */
function agentSessionReservationTouchedProvider(record: AgentSessionRecord): boolean {
  return record.providerHandleChain.at(-1)?.mintedAtFence === record.lease.runtimeFence
}

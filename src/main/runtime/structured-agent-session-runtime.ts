// Where the structured agent-session wire becomes a live host on this runtime.
//
// Built on the first `agentSession.*` call rather than at startup: the record
// store and the journals live under the profile's user-data path, which is not
// final until Electron is ready, and a runtime that never serves a structured
// session should not pay for a store it will never read. The slot the RPC layer
// reads is module-level for the same reason the registry is — the runtime
// service is already far past its size budget.

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
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

/** Sibling of the journal tree rather than inside it: one file adjudicates every
 *  session's lease, while a journal is per session. */
const RECORD_STORE_DIR_NAME = 'agent-sessions'

export type StructuredAgentSessionRuntimeDeps = {
  /** Host state root. The record store and the journal tree both hang off it. */
  stateDirectory: string
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: () => string
  /** Transport for the Codex child. Overridden only to drive the whole runtime
   *  against a scripted app-server; production spawns the real one. */
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  onError?: (input: { scope: string; error: unknown }) => void
  handoffTransport?: StructuredAgentSessionHandoffTransport
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
  const store = await AgentSessionRecordStore.open({
    directory: join(deps.stateDirectory, RECORD_STORE_DIR_NAME),
    hostId: deps.hostId
  })
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => store.getRecord(sessionId))
  try {
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: createCodexStructuredLaunchResolver({
        store,
        resolveWorkspacePath: deps.resolveWorkspacePath,
        ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
      }),
      ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {})
    })
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: deps.stateDirectory,
      claimKeyId: deps.claimKeyId,
      probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
      resolveLaunchEnv: async () =>
        (await (deps.resolveLaunchEnv ?? resolveLoginShellEnvironment)()) as Record<string, string>,
      onEventSinkError: ({ sessionId, error }) =>
        deps.onError?.({ scope: `structured-agent-session-journal:${sessionId}`, error }),
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
 * answer PID-reuse-safely reports `indeterminate`, which routes the session to
 * manual recovery instead of minting a second writer on the same Codex thread.
 */
export function createStructuredAgentSessionOwnerProbe(
  hostId: string,
  probe = probeAgentSessionProcessIdentity
): (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe> {
  return async (record) => {
    const owner = record.lease.ownerProcess
    if (!owner) {
      if (record.lease.processlessAt !== undefined && record.lease.processlessAt !== null) {
        return { outcome: 'reservation-unused' }
      }
      // Freeing a reservation needs positive proof that nothing spawned under
      // its token, and this host has no spawn-token process scan yet.
      return {
        outcome: 'indeterminate',
        reason: 'reservation named no process, and this host cannot scan for its spawn token'
      }
    }
    if (owner.hostId !== hostId) {
      // Checking a remote host's pid against this machine's process table is
      // exactly how a live owner gets declared dead.
      return {
        outcome: 'indeterminate',
        reason: `owner runs on ${owner.hostId}, which this host cannot probe`
      }
    }
    return probe({ identity: owner })
  }
}

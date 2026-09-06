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
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionAdapterDeps
} from '../codex/codex-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude/claude-structured-session-adapter'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  readClaudeManagedAccountGateSettings,
  type ClaudeManagedAccountGateSettings
} from '../native-chat/claude-structured-managed-account-support'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import { stopOrphanAgentSessionChildren } from './agent-session-orphan-child-reaper'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'

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
  resolveClaudeCommand?: () => string
  /** Provider transports are overridden only to drive the runtime against scripted children. */
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  resolveLaunchArgs?: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** Required, and asserted at install time — an absent policy must not degrade to a guess. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** Raw settings getter; the reader that fails closed around it is built here, in checked code. */
  getClaudeManagedAccountGateSettings?: () => ClaudeManagedAccountGateSettings
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
  onError?: (input: { scope: string; error: unknown }) => void
  handoffTransport?: StructuredAgentSessionHandoffTransport
  reapOrphanChildren?: typeof stopOrphanAgentSessionChildren
}

type InstalledRuntime = {
  host: StructuredAgentSessionHost
  adapter: { closeAll(): Promise<void> }
  /** Resolves after every observed adapter exit has published, and every
   *  recovery callback it raised has settled. */
  waitForRecovery: () => Promise<void>
}

let installing: Promise<InstalledRuntime> | null = null

/** Thrown when the host is installed without a Claude auth policy resolver. */
export const CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED =
  'structured agent-session host requires a Claude auth policy resolver'

/**
 * Runtimes whose teardown did not finish. `installing` is cleared regardless so
 * nothing new attaches, but dropping the runtime as well would strand every
 * journal the host retained for a retry: `tearDownStructuredAgentSessionHost`
 * deliberately keeps a failed close indexed, and only a later stop through this
 * same runtime can reach those entries again.
 */
const pendingTeardown = new Set<InstalledRuntime>()

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

/** Resolves once every provider exit observed so far has been published by its
 *  adapter and reconciled by the host. Nothing is installed, nothing to wait on.
 *
 *  This is the only handle onto that barrier: reconciliation is driven by exit
 *  callbacks, so a caller that needs the settled lease — rather than the one the
 *  exit is still being reconciled out of — has no other way to know it landed. */
export async function waitForStructuredAgentSessionRecovery(): Promise<void> {
  const installed = await installing?.catch(() => null)
  await installed?.waitForRecovery()
}

/** Drops the host and reaps every Codex child under it. Runtime teardown and
 *  test isolation take the same path, so neither can leave a live app-server.
 *
 *  A teardown that fails is RETRIED by the next stop rather than forgotten: the
 *  host keeps every journal whose close rejected, and this is the only handle
 *  onto that host once the module slot is cleared. */
export async function stopStructuredAgentSessionRuntime(): Promise<void> {
  const pending = installing
  installing = null
  setStructuredAgentSessionHost(null)
  agentSessionPtyWriteGate.detachRecordLookup()
  const outstanding = [...pendingTeardown]
  pendingTeardown.clear()
  const installed = pending ? await pending.catch(() => null) : null
  if (installed) {
    outstanding.push(installed)
  }
  const failures: unknown[] = []
  for (const runtime of outstanding) {
    try {
      await tearDownRuntime(runtime)
    } catch (error) {
      pendingTeardown.add(runtime)
      failures.push(error)
    }
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
  }
}

async function tearDownRuntime(installed: InstalledRuntime): Promise<void> {
  // Drain an in-flight recovery before stopping children; recovery may still
  // be writing lifecycle rows or acquiring a replacement child.
  await installed.waitForRecovery()
  try {
    await installed.adapter.closeAll()
  } finally {
    // closeAll can itself deliver a final exit callback; observe that callback
    // before flushing and releasing the host's journal resources.
    await installed.waitForRecovery()
    await installed.host.flushAllStreamedEvents()
  }
}

async function install(deps: StructuredAgentSessionRuntimeDeps): Promise<InstalledRuntime> {
  // Why thrown rather than defaulted: the caller is `@ts-nocheck`, so a dropped
  // field arrives here as `undefined`. Refusing to install is loud; guessing a
  // policy is the silent under-strip this assertion exists to prevent.
  if (typeof deps.resolveClaudeAuthPolicy !== 'function') {
    throw new Error(CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED)
  }
  const bootEnvironment = (deps.resolveEnvironment ?? resolveLoginShellEnvironment)()
  const resolveCodexEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
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
    let host: StructuredAgentSessionHost | null = null
    let recoveryChain = Promise.resolve()
    const codex = new CodexStructuredSessionAdapter({
      resolveLaunch: createCodexStructuredLaunchResolver({
        store,
        resolveWorkspacePath: deps.resolveWorkspacePath,
        resolveEnvironment: resolveCodexEnvironment,
        ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
      }),
      ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
      ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
      onEvent: (event) => {
        if (event.type !== 'ended' || !('cause' in event) || event.cause !== 'unexpected-exit') {
          return
        }
        // Serialize recovery with teardown. Exit callbacks arrive from child
        // process tasks, so a fire-and-forget callback can otherwise append
        // after the host has flushed and its journal directory is removed.
        recoveryChain = recoveryChain.then(async () => {
          try {
            await host?.handleAdapterEvent(event)
          } catch (error) {
            deps.onError?.({ scope: `structured-agent-session-exit:${event.sessionId}`, error })
          }
        })
      }
    })
    const claude = createStructuredClaudeRuntimeAdapter({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
      ...(deps.resolveClaudeLaunchEnv
        ? { resolveClaudeLaunchEnv: deps.resolveClaudeLaunchEnv }
        : {}),
      resolveClaudeAuthPolicy: deps.resolveClaudeAuthPolicy,
      ...(deps.getClaudeManagedAccountGateSettings
        ? {
            readClaudeManagedAccountGate: () =>
              readClaudeManagedAccountGateSettings(deps.getClaudeManagedAccountGateSettings!)
          }
        : {}),
      onUnexpectedExit: (event) => {
        recoveryChain = recoveryChain.then(async () => {
          try {
            await host?.handleAdapterEvent(event)
          } catch (error) {
            deps.onError?.({ scope: `structured-agent-session-exit:${event.sessionId}`, error })
          }
        })
      },
      onBackgroundTasksChanged: (sessionId, state) =>
        host?.publishBackgroundTaskState(sessionId, state),
      ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
      ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
    })
    const adapter = new StructuredAgentSessionAdapterRouter({ codex, claude }, async () => {
      await Promise.all([codex.closeAll(), claude.closeAll()])
    })
    host = new StructuredAgentSessionHost({
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
    return {
      host,
      adapter,
      waitForRecovery: async () => {
        // A recovery may synchronously trigger another exit while it is
        // reacquiring. Observe until the chain stops growing.
        for (;;) {
          // Claude reaches the chain only once its close ladder and transcript
          // write publish the exit, so an observed death is not yet a chained
          // one. Codex publishes inside its own exit callback and needs nothing.
          await claude.drainObservedExits()
          const observed = recoveryChain
          await observed
          if (observed === recoveryChain) {
            return
          }
        }
      }
    }
  } catch (error) {
    agentSessionPtyWriteGate.detachRecordLookup()
    throw error
  }
}

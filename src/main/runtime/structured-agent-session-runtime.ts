// Where the structured agent-session wire becomes a live host on this runtime.
//
// Built on the first `agentSession.*` call rather than at startup: the record
// store and the journals live under the profile's user-data path, which is not
// final until Electron is ready, and a runtime that never serves a structured
// session should not pay for a store it will never read. The slot the RPC layer
// reads is module-level for the same reason the registry is — the runtime
// service is already far past its size budget.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { DISPATCH_DOUBT_PROVIDER_IDLE } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import type { AgentSessionResumeTrigger } from '../../shared/agent-session-resume-marker'
import {
  structuredAgentSessionTeardownTrigger,
  tearDownRuntime,
  type InstalledRuntime
} from './structured-agent-session-runtime-teardown'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import { AgentSessionSavedStatusStore } from './agent-session-saved-status-store'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import type { CodexStructuredPermissionPolicy } from '../codex/codex-structured-permission-policy'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionAdapterDeps
} from '../codex/codex-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude/claude-structured-session-adapter'
import {
  StructuredAgentSessionHost,
  type StructuredAgentSessionHostDeps
} from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
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
import type { NativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  modelCatalogHostDeps,
  type RuntimeAgentAccountHomeResolver
} from './structured-agent-model-catalog-wiring'

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
  /** The user's Agent Permissions setting for Claude; absent means prompting. */
  resolveClaudePermissionMode?: () => Promise<PermissionMode> | PermissionMode
  /** The same setting for Codex, as app-server thread policy. */
  resolveCodexPermissionPolicy?: () => CodexStructuredPermissionPolicy
  /** Raw settings getter; the reader that fails closed around it is built here, in checked code. */
  getClaudeManagedAccountGateSettings?: () => ClaudeManagedAccountGateSettings
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Which login-shell variables Codex and Claude children inherit; absent inherits all. */
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
  onError?: (input: { scope: string; error: unknown }) => void
  /** Every structured-session status projection, for host-side reactions such as the first-work
   *  workspace rename that CLI agents get from their hooks. */
  onSessionStatusChanged?: StructuredAgentSessionHostDeps['onSessionStatusChanged']
  /** The agent-status store; see `StructuredAgentSessionHostDeps.statusSink`. */
  statusSink?: StructuredAgentSessionHostDeps['statusSink']
  /** See `StructuredAgentSessionHostDeps.hasOpenDispatch`. */
  hasOpenDispatch?: StructuredAgentSessionHostDeps['hasOpenDispatch']
  reapOrphanChildren?: typeof stopOrphanAgentSessionChildren
  /** The account home a structured launch would pin right now, for catalog
   *  reads with no session record. Absent disables the catalog surface. */
  resolveAgentAccountHome?: RuntimeAgentAccountHomeResolver
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
export async function stopStructuredAgentSessionRuntime(options?: {
  trigger?: AgentSessionResumeTrigger
}): Promise<void> {
  const trigger = options?.trigger ?? structuredAgentSessionTeardownTrigger()
  const pending = installing
  installing = null
  setStructuredAgentSessionHost(null)
  const outstanding = [...pendingTeardown]
  pendingTeardown.clear()
  const installed = pending ? await pending.catch(() => null) : null
  if (installed) {
    outstanding.push(installed)
  }
  const failures: unknown[] = []
  for (const runtime of outstanding) {
    try {
      await tearDownRuntime(runtime, trigger)
    } catch (error) {
      pendingTeardown.add(runtime)
      failures.push(error)
    }
  }
  await agentModelCatalogStore.flushPersistence()
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
  }
}

async function install(deps: StructuredAgentSessionRuntimeDeps): Promise<InstalledRuntime> {
  // Why thrown rather than defaulted: the caller is `@ts-nocheck`, so a dropped
  // field arrives here as `undefined`. Refusing to install is loud; guessing a
  // policy is the silent under-strip this assertion exists to prevent.
  if (typeof deps.resolveClaudeAuthPolicy !== 'function') {
    throw new Error(CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED)
  }
  const envResolvers = createStructuredAgentEnvironmentResolvers(deps)
  const { resolveCodexEnvironment, resolveClaudeInheritedEnv } = envResolvers
  const store = await AgentSessionRecordStore.open({
    directory: join(deps.stateDirectory, RECORD_STORE_DIR_NAME),
    hostId: deps.hostId
  })
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
  let host: StructuredAgentSessionHost | null = null
  const lifecycle = createStructuredAgentSessionLifecycleDelivery({
    handle: (event) => host?.handleAdapterEvent(event),
    ...(deps.onError ? { onError: deps.onError } : {}),
    // Claude publishes an observed exit only after its close ladder and transcript write; Codex
    // publishes inside its own exit callback and needs nothing.
    drainObservedExits: () => claude.drainObservedExits()
  })
  const onDispatchSettledLate = (
    settlement: Parameters<StructuredAgentSessionHost['settleLateDispatch']>[0]
  ): void => {
    void host?.settleLateDispatch(settlement).catch((error) =>
      deps.onError?.({
        scope: `structured-agent-session-late-settlement:${settlement.sessionId}`,
        error
      })
    )
  }
  const codex = new CodexStructuredSessionAdapter({
    resolveLaunch: createCodexStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: resolveCodexEnvironment,
      ...(deps.resolveCodexPermissionPolicy
        ? { resolvePermissionPolicy: deps.resolveCodexPermissionPolicy }
        : {}),
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
    }),
    ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore,
    onBackgroundTasksChanged: (sessionId, state) =>
      host?.publishBackgroundTaskState(sessionId, state),
    onDispatchSettledLate,
    onPrimaryThreadStoppedRunning: ({ sessionId }) => {
      void host
        ?.releaseUnansweredDispatches({
          sessionId,
          reason: DISPATCH_DOUBT_PROVIDER_IDLE
        })
        .catch((error) =>
          deps.onError?.({
            scope: `structured-agent-session-unanswered-dispatch:${sessionId}`,
            error
          })
        )
    },
    onEvent: (event) => {
      if (event.type === 'ended' && 'cause' in event && event.cause === 'unexpected-exit') {
        lifecycle.deliver(event)
      }
    }
  })
  const claude = createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
    ...(deps.resolveClaudeLaunchEnv ? { resolveClaudeLaunchEnv: deps.resolveClaudeLaunchEnv } : {}),
    resolveClaudeInheritedEnv,
    resolveClaudeAuthPolicy: deps.resolveClaudeAuthPolicy,
    ...(deps.resolveClaudePermissionMode
      ? { resolveClaudePermissionMode: deps.resolveClaudePermissionMode }
      : {}),
    ...(deps.getClaudeManagedAccountGateSettings
      ? {
          readClaudeManagedAccountGate: () =>
            readClaudeManagedAccountGateSettings(deps.getClaudeManagedAccountGateSettings!)
        }
      : {}),
    onLifecycleEvent: (event) => lifecycle.deliver(event),
    onBackgroundTasksChanged: (sessionId, state) =>
      host?.publishBackgroundTaskState(sessionId, state),
    onDispatchSettledLate,
    ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore
  })
  const adapter = new StructuredAgentSessionAdapterRouter({ codex, claude }, async () => {
    await Promise.all([codex.closeAll(), claude.closeAll()])
  })
  const savedStatus = AgentSessionSavedStatusStore.open(deps.stateDirectory)
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    recoveryCapsule: new AgentSessionRecoveryCapsule(deps.stateDirectory),
    savedStatus,
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
    ...(deps.onSessionStatusChanged ? { onSessionStatusChanged: deps.onSessionStatusChanged } : {}),
    ...(deps.statusSink ? { statusSink: deps.statusSink } : {}),
    ...(deps.hasOpenDispatch ? { hasOpenDispatch: deps.hasOpenDispatch } : {}),
    ...(await modelCatalogHostDeps({ store, deps, envResolvers }))
  })
  setStructuredAgentSessionHost(host)
  return {
    host,
    adapter,
    savedStatus,
    waitForRecovery: lifecycle.drain
  }
}

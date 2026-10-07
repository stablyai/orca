// Where the structured agent-session wire becomes a live host on this runtime.
//
// Built on the first `agentSession.*` call rather than at startup: the record
// store and the journal live under the profile's user-data path, which is not
// final until Electron is ready, and a runtime that never serves a structured
// session should not pay for a store it will never read. The slot the RPC layer
// reads is module-level for the same reason the registry is — the runtime
// service is already far past its size budget.
//
// A process whose journal will not open installs none and answers every
// structured request with the refusal that says why.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionResumeTrigger } from '../../shared/agent-session-resume-marker'
import type { StructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import {
  structuredAgentSessionTeardownTrigger,
  tearDownRuntime,
  type InstalledRuntime
} from './structured-agent-session-runtime-teardown'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import type { CodexStructuredPermissionPolicy } from '../codex/codex-structured-permission-policy'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude/claude-structured-session-adapter'
import {
  StructuredAgentSessionHost,
  type StructuredAgentSessionHostDeps
} from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from './structured-agent-session-attachment-wiring'
import {
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore,
  type OpenedAgentSessionRecordStore
} from './agent-session-record-store-slot'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { journalDatabaseHoldsAgentSessions } from '../native-chat/agent-session-journal/journal-database'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
import type { NativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  type StructuredAgentAdapterContext
} from './structured-agent-runtime-registrations'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'
import { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  modelCatalogHostDeps,
  type RuntimeAgentAccountHomeResolver
} from './structured-agent-model-catalog-wiring'
import type { ClaudeThinkingDisplaySupport } from '../claude/claude-thinking-display-support'

/** Whether this profile holds a structured chat: a record or tab in the journal database. */
export function hasPersistedStructuredAgentSessionStore(
  stateDirectory: string,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  const databasePath = journalDatabasePath(stateDirectory)
  if (!fileExists(databasePath)) {
    return false
  }
  try {
    return journalDatabaseHoldsAgentSessions(databasePath)
  } catch {
    // A database that cannot be read cannot say it is empty.
    return true
  }
}

export type StructuredAgentSessionRuntimeDeps = {
  /** Host state root. The record store and the journal database both hang off it. */
  stateDirectory: string
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  findTerminalAgentSessionOwner?: StructuredAgentSessionHostDeps['findTerminalAgentSessionOwner']
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  resolveClaudeCommand?: () => string
  /** Whether a Claude CLI takes the thinking-display flag; absent never passes it. */
  claudeThinkingDisplay?: ClaudeThinkingDisplaySupport
  /** Provider transports are overridden only to drive the runtime against scripted children. */
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  /** Required, and asserted at install time — saved Arguments must never be silently omitted. */
  resolveLaunchArgs: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** Required, and asserted at install time — an absent policy must not degrade to a guess. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** The user's Agent Permissions setting for Claude; absent means prompting. */
  resolveClaudePermissionMode?: () => Promise<PermissionMode> | PermissionMode
  /** The same setting for Codex, as app-server thread policy. */
  resolveCodexPermissionPolicy?: () => CodexStructuredPermissionPolicy
  /** The same setting for a protocol-driven (ACP) agent: whether it runs with full access. */
  resolveAgentFullAccess?: (agent: string) => boolean
  /** The user's per-agent environment overlay, for agents with no lane-specific resolver. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
  /** Raw settings getter; the reader that fails closed around it is built here, in checked code. */
  getClaudeManagedAccountGateSettings?: () => ClaudeManagedAccountGateSettings
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Which login-shell variables Codex and Claude children inherit; absent inherits all. */
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
  /** Where every failure the runtime and its host carry on past is reported. Required, so no path
   *  can drop one: the desktop and headless hosts both pass the trace-file logger. */
  logger: StructuredAgentSessionLogger
  /** Every structured-session status projection, for host-side reactions such as the first-work
   *  workspace rename that CLI agents get from their hooks. */
  onSessionStatusChanged?: StructuredAgentSessionHostDeps['onSessionStatusChanged']
  /** The agent-status store; see `StructuredAgentSessionHostDeps.statusSink`. */
  statusSink?: StructuredAgentSessionHostDeps['statusSink']
  /** See `StructuredAgentSessionHostDeps.hasOpenDispatch`. */
  hasOpenDispatch?: StructuredAgentSessionHostDeps['hasOpenDispatch']
  /** See `StructuredAgentSessionHostDeps.onSessionTabHidden`. */
  onSessionTabHidden?: StructuredAgentSessionHostDeps['onSessionTabHidden']
  /** Host-owned phone delivery and reconciliation from the current journal projection. */
  attentionDelivery?: StructuredAttentionMobileDelivery
  /** The account home a structured launch would pin right now, for catalog
   *  reads with no session record. Absent disables the catalog surface. */
  resolveAgentAccountHome?: RuntimeAgentAccountHomeResolver
}

let installing: Promise<InstalledRuntime> | null = null

/** Thrown when the host is installed without a Claude auth policy resolver. */
export const CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED =
  'structured agent-session host requires a Claude auth policy resolver'

export const STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED =
  'structured agent-session host requires a launch arguments resolver'

/** Thrown when the host is installed without a logger: every failure it carries on past would
 *  otherwise reach nobody. */
export const STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED =
  'structured agent-session host requires a logger'

/**
 * Runtimes whose teardown did not finish. `installing` is cleared regardless so
 * nothing new attaches, but dropping the runtime as well would strand every
 * conversation the host kept indexed for a retry — and the journal connection,
 * which closes only once they are settled — so a later stop retries them here.
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
 *  host keeps every conversation it could not settle, and this is the only handle
 *  onto that host once the module slot is cleared. */
export async function stopStructuredAgentSessionRuntime(options?: {
  trigger?: AgentSessionResumeTrigger
}): Promise<void> {
  const trigger = options?.trigger ?? structuredAgentSessionTeardownTrigger()
  const pending = installing
  installing = null
  setStructuredAgentSessionHost(null)
  stopAgentSessionAttachments()
  const outstanding = [...pendingTeardown]
  pendingTeardown.clear()
  const installed = pending ? await pending.catch(() => null) : null
  if (installed) {
    outstanding.push(installed)
  }
  // A store admission opened with no host built on it has no teardown to close its database.
  const recordStore = await releaseAgentSessionRecordStore()
  if (
    recordStore &&
    !outstanding.some((runtime) => runtime.journalDatabase === recordStore.journalDatabase)
  ) {
    recordStore.journalDatabase.close()
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
  if (typeof deps.resolveLaunchArgs !== 'function') {
    throw new Error(STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED)
  }
  const declared: Partial<StructuredAgentSessionLogger> | undefined = deps.logger
  if (typeof declared?.warn !== 'function' || typeof declared.error !== 'function') {
    throw new Error(STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED)
  }
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  // The store launch admission may already have opened; a failed install leaves it to that slot.
  const recordStore = await openAgentSessionRecordStoreOnce({
    stateDirectory: deps.stateDirectory,
    hostId: deps.hostId,
    logger
  })
  return await installOnJournal({ ...deps, logger }, recordStore)
}

async function installOnJournal(
  deps: StructuredAgentSessionRuntimeDeps,
  { journalDatabase, store }: OpenedAgentSessionRecordStore
): Promise<InstalledRuntime> {
  const envResolvers = createStructuredAgentEnvironmentResolvers(deps)
  let host: StructuredAgentSessionHost | null = null
  const lifecycle = createStructuredAgentSessionLifecycleDelivery({
    handle: (event) => host?.handleAdapterEvent(event),
    logger: deps.logger,
    // An agent that publishes an observed exit only after its own close work drains it here.
    drainObservedExits: async () => {
      await Promise.all(
        registrations.map(({ adapter }) => adapter.drainObservedExits?.() ?? Promise.resolve())
      )
    }
  })
  const context: StructuredAgentAdapterContext = {
    deps,
    store,
    journalDatabase,
    environment: envResolvers,
    deliverLifecycle: lifecycle.deliver,
    followUps: createStructuredAgentSessionDispatchFollowUps({
      host: () => host,
      logger: deps.logger
    }),
    host: () => host
  }
  const registrations = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
    ({ definition, createAdapter }) => ({ definition, adapter: createAdapter(context) })
  )
  const agents = new StructuredAgentRegistry(registrations)
  const adapter = new StructuredAgentSessionAdapterRouter(agents, async () => {
    await Promise.all(registrations.map((registration) => registration.adapter.closeAll()))
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    agents,
    recoveryCapsule: new AgentSessionRecoveryCapsule(deps.stateDirectory),
    journalDatabase,
    claimKeyId: deps.claimKeyId,
    ...(deps.findTerminalAgentSessionOwner
      ? { findTerminalAgentSessionOwner: deps.findTerminalAgentSessionOwner }
      : {}),
    probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
    probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    logger: deps.logger,
    ...(deps.onSessionStatusChanged ? { onSessionStatusChanged: deps.onSessionStatusChanged } : {}),
    ...(deps.statusSink ? { statusSink: deps.statusSink } : {}),
    ...(deps.hasOpenDispatch ? { hasOpenDispatch: deps.hasOpenDispatch } : {}),
    ...(deps.onSessionTabHidden ? { onSessionTabHidden: deps.onSessionTabHidden } : {}),
    ...(await modelCatalogHostDeps({ store, agents, deps, envResolvers }))
  })
  if (deps.attentionDelivery) {
    const installed = host
    const delivery = deps.attentionDelivery
    // Lives exactly as long as the host: teardown drops the host and its subscribers together.
    installed.subscribeTurnCompletions({
      id: 'host-attention-delivery',
      includePrompts: true,
      emit: (event) => {
        if (event.type === 'end') {
          return
        }
        const sessionId =
          event.type === 'prompt' ? event.prompt.sessionId : event.completion.sessionId
        delivery.deliver(event, installed.readStatusSummary(sessionId))
      },
      onState: delivery.reconcile
    })
  }
  setStructuredAgentSessionHost(host)
  installAgentSessionAttachments({
    stateDirectory: deps.stateDirectory,
    store,
    journalDatabase,
    logger: deps.logger
  })
  return {
    host,
    adapter,
    journalDatabase,
    waitForRecovery: lifecycle.drain
  }
}

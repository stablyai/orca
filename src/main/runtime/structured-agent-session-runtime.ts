// Install lazily after Electron finalizes the profile path; runtimes without structured requests need no store. Journal-open failures install a refusal.

import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentSessionTransportOverrides } from './structured-agent-session-transport-overrides'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionResumeTrigger } from '../../shared/agent-session-resume-marker'
import type { StructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import {
  structuredAgentSessionTeardownTrigger,
  tearDownRuntime,
  type InstalledRuntime
} from './agent-session/structured-agent-session-runtime-teardown'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type {
  StructuredAgentSessionHost,
  StructuredAgentSessionHostDeps
} from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { stopAgentSessionAttachments } from './structured-agent-session-attachment-wiring'
import {
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore
} from './agent-session-record-store-slot'
import type { NativeChatShellEnvironmentPolicy } from '../../shared/native-chat/native-chat-shell-environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { RuntimeAgentAccountHomeResolver } from './structured-agent-model-catalog-wiring'
import type { ClaudeCliFlagSupport } from '../claude/claude-cli-flag-support'
import { migrateLegacyNativeChatVisualsFolders } from '../native-chat/native-chat-scratch-folder-migration'

export { hasPersistedStructuredAgentSessionStore } from './agent-session-record-store-slot'

export type StructuredAgentSessionRuntimeDeps = StructuredAgentSessionTransportOverrides & {
  stateDirectory: string
  /** Only probe or spawn records pinned to this execution host. */
  hostId: string
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  resolveClaudeCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Which version-gated flags a Claude CLI takes; absent never passes one. */
  claudeCliFlags?: ClaudeCliFlagSupport
  /** Create per-chat visuals/scratch folders and sweep retired chats; only real hosts load the bundled skill. */
  nativeChatVisuals?: {
    isEnabled: () => boolean
  }
  /** Required at installation so saved Arguments cannot be silently omitted. */
  resolveLaunchArgs: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  /** Required at installation so authentication policy is never guessed. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** Backfill permission mode once for chats saved before modes existed. */
  resolveAgentFullAccess?: (agent: string) => boolean
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
  resolveAgentCommandSettings?: () => StructuredAgentCommandSettings
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Which login-shell variables Codex and Claude children inherit; absent inherits all. */
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  /** Required so carried-on failures reach the desktop/headless trace logger. */
  logger: StructuredAgentSessionLogger
  /** Host reactions to status, including the first-work workspace rename CLI hooks provide. */
  onSessionStatusChanged?: StructuredAgentSessionHostDeps['onSessionStatusChanged']
  conversationNaming?: StructuredAgentSessionHostDeps['conversationNaming']
  /** See `StructuredAgentSessionHostDeps.hasOpenDispatch`. */
  hasOpenDispatch?: StructuredAgentSessionHostDeps['hasOpenDispatch']
  resolveCodexAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  /** Launch prep's sync for a probed home; see `CodexModelCatalogProbeDeps.prepareHome`. */
  prepareCodexCatalogProbeHome?: (homePath: string) => void
  /** See `StructuredAgentSessionHostDeps.onSessionTabHidden`. */
  onSessionTabHidden?: StructuredAgentSessionHostDeps['onSessionTabHidden']
  /** See `StructuredAgentSessionHostDeps.assertNoTerminalWriter`. */
  assertNoTerminalWriter?: StructuredAgentSessionHostDeps['assertNoTerminalWriter']
  /** Host-owned phone delivery and reconciliation from the current journal projection. */
  attentionDelivery?: StructuredAttentionMobileDelivery
  /** Resolve the account home launch would pin for catalog reads without a session; absent disables catalogs. */
  resolveAgentAccountHome?: RuntimeAgentAccountHomeResolver
} & Pick<StructuredAgentSessionHostDeps, 'onRequestFailure' | 'statusSink'>

let installing: Promise<InstalledRuntime> | null = null

export const CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED =
  'structured agent-session host requires a Claude auth policy resolver'

export const STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED =
  'structured agent-session host requires a launch arguments resolver'

export const STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED =
  'structured agent-session host requires a logger'

/** Keep failed teardowns after clearing the install slot so later stops retry their indexed conversations and journal connection. */
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

/** Wait until observed exits publish and host reconciliation settles; callbacks alone cannot tell callers when lease updates land. */
export async function waitForStructuredAgentSessionRecovery(): Promise<void> {
  const installed = await installing?.catch(() => null)
  await installed?.waitForRecovery()
}

/** Stop every provider child; retain failed teardowns for retry after the install slot clears. */
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
  // A default policy could attribute sign-in failures to the wrong account.
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
  try {
    // Without the Arguments source there is nothing to fill from; missing modes run Ask.
    if (deps.resolveAgentFullAccess) {
      await recordStore.store.backfillChatPermissionModes(deps.resolveAgentFullAccess)
    }
  } catch (error) {
    // Missing choices safely run Ask; the next host install retries this pass.
    logger.warn('saving existing chat permission choices failed', {
      scope: 'permission-mode-backfill',
      error
    })
  }
  // Before the host serves reads: a chat opened right after an update finds its visuals in place.
  await migrateLegacyNativeChatVisualsFolders(deps.stateDirectory, logger)
  const { installOnJournal } = await import('./structured-agent-session-host-assembly')
  return await installOnJournal({ ...deps, logger }, recordStore)
}

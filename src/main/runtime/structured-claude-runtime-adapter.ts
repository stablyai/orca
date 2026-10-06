import type { AgentProfileConnectionService } from '../agent-profiles/connection-service'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionRecord, AgentSessionAccountHome } from '../../shared/agent-session-record'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { createClaudeStructuredLaunchResolver } from '../claude/claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionAdapterDeps
} from '../claude/claude-structured-session-adapter'
import { claudeProviderHandleLink } from '../claude/claude-structured-owner-identity'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStructuredSessionEvent } from '../claude/claude-structured-session-state'
import {
  recordAgentSessionProviderHandle,
  reviseAgentSessionProviderResumePoint
} from './agent-session-provider-handle-transition'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { ClaudeAtRestCommandCatalog } from '../claude/claude-at-rest-commands'

export type StructuredClaudeRuntimeAdapterDeps = {
  agentProfiles?: AgentProfileConnectionService
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveClaudeCommand?: () => string
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** The env a Claude child inherits before auth stripping; absent inherits Orca's own. */
  resolveClaudeInheritedEnv?: () => Promise<Record<string, string>>
  /** Managed-account auth state for a Claude launch, mirroring the terminal preflight.
   *  Required: an absent policy is what silently under-strips. */
  resolveClaudeAuthPolicy: (
    home?: AgentSessionAccountHome
  ) => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** The user's Agent Permissions setting for Claude; absent means prompting. */
  resolveClaudePermissionMode?: () => Promise<PermissionMode> | PermissionMode
  readClaudeManagedAccountGate?: () => ClaudeManagedAccountGateSettings | null
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: ClaudeStructuredSessionAdapterDeps['readProcessStartTime']
  modelCatalog?: ClaudeStructuredSessionAdapterDeps['modelCatalog']
  onLifecycleEvent: (event: StructuredAgentSessionLifecycleEvent) => void
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
  onSessionIdle?: ClaudeStructuredSessionAdapterDeps['onSessionIdle']
  onChildWorkEvidence?: ClaudeStructuredSessionAdapterDeps['onChildWorkEvidence']
  logger?: ClaudeStructuredSessionAdapterDeps['logger']
}

/** The adapter events the host's lifecycle handler consumes, in the host's vocabulary. */
export function structuredClaudeLifecycleEvent(
  event: ClaudeStructuredSessionEvent
): StructuredAgentSessionLifecycleEvent | null {
  if (event.type === 'started') {
    return event
  }
  // Every exit of a child with an identity, expected or not: the host ends that child's record.
  if (
    event.type === 'ended' &&
    event.cause !== undefined &&
    event.fence !== undefined &&
    event.acquisitionGeneration
  ) {
    return {
      type: 'ended',
      sessionId: event.sessionId,
      reason: event.reason,
      ...(event.failure ? { failure: event.failure } : {}),
      cause: event.cause,
      fence: event.fence,
      acquisitionGeneration: event.acquisitionGeneration,
      // The instant the translator ended the open turn at; the host reads the exit's turn by it.
      ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt }),
      ...(event.startupUnproven ? { startupUnproven: event.startupUnproven } : {})
    }
  }
  return null
}

export function createStructuredClaudeRuntimeAdapter(
  deps: StructuredClaudeRuntimeAdapterDeps
): ClaudeStructuredSessionAdapter {
  const { store } = deps
  return new ClaudeStructuredSessionAdapter({
    hasProfileBinding: (sessionId) => Boolean(store.getRecord(sessionId)?.accountHome.agentProfile),
    atRestCommands: new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: deps.resolveWorkspacePath
    }),
    resolveLaunch: createClaudeStructuredLaunchResolver({
      store,
      agentProfiles: deps.agentProfiles,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveCommand: deps.resolveClaudeCommand ?? resolveClaudeCommand,
      ...(deps.resolveClaudeLaunchEnv ? { resolveEnv: deps.resolveClaudeLaunchEnv } : {}),
      ...(deps.resolveClaudeInheritedEnv
        ? { resolveInheritedEnv: deps.resolveClaudeInheritedEnv }
        : {}),
      resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
      ...(deps.resolveClaudePermissionMode
        ? { resolvePermissionMode: deps.resolveClaudePermissionMode }
        : {}),
      ...(deps.readClaudeManagedAccountGate
        ? { readManagedAccountGate: deps.readClaudeManagedAccountGate }
        : {})
    }),
    persistHandle: async ({ sessionId, providerSessionId, leafUuid, fence }) => {
      const currentFence = store.getRecord(sessionId)?.lease.runtimeFence ?? fence
      const observedAt = Date.now()
      await store.transitionHandoff(sessionId, (record: AgentSessionRecord) =>
        recordAgentSessionProviderHandle({
          record,
          fence: currentFence,
          link: claudeProviderHandleLink({
            sessionId: providerSessionId,
            leafUuid,
            resumed: true,
            fence: currentFence,
            observedAt
          }),
          now: observedAt
        })
      )
    },
    persistResumePoint: async ({ sessionId, providerSessionId, leafUuid, fence }) => {
      await store.transitionHandoff(sessionId, (record: AgentSessionRecord) =>
        reviseAgentSessionProviderResumePoint({
          record,
          fence,
          handle: claudeProviderHandle(providerSessionId, leafUuid),
          now: Date.now()
        })
      )
    },
    onEvent: (event) => {
      const lifecycle = structuredClaudeLifecycleEvent(event)
      if (lifecycle) {
        deps.onLifecycleEvent(lifecycle)
      }
    },
    ...(deps.onDispatchSettledLate ? { onDispatchSettledLate: deps.onDispatchSettledLate } : {}),
    ...(deps.onSessionIdle ? { onSessionIdle: deps.onSessionIdle } : {}),
    ...(deps.onChildWorkEvidence ? { onChildWorkEvidence: deps.onChildWorkEvidence } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.openClaudeConnection ? { openConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {})
  })
}

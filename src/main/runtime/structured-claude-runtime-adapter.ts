import { proveClaudeTranscriptBranch } from '../claude/claude-transcript-branch-proof'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { join } from 'node:path'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { createClaudeStructuredLaunchResolver } from '../claude/claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionAdapterDeps
} from '../claude/claude-structured-session-adapter'
import { claudeProviderHandleLink } from '../claude/claude-structured-owner-identity'
import { readClaudeTranscriptConversationName } from '../claude/claude-transcript-conversation-name'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  readClaudeTranscriptLeafUuid,
  resolveSessionFilePath
} from '../native-chat/session-file-resolver'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import type { AgentSessionRecordStore } from './agent-session-record-store'

export type StructuredClaudeRuntimeAdapterDeps = {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveClaudeCommand?: () => string
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** Managed-account auth state for a Claude launch, mirroring the terminal preflight.
   *  Required: an absent policy is what silently under-strips. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  readClaudeManagedAccountGate?: () => ClaudeManagedAccountGateSettings | null
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: ClaudeStructuredSessionAdapterDeps['readProcessStartTime']
  onUnexpectedExit: (event: StructuredAgentSessionLifecycleEvent) => void
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
  onConversationName?: (sessionId: string, conversationName: string) => void
  readNamingState?: (sessionId: string) => {
    conversationName: string | null
    namingAttempted: boolean
  }
  markNamingAttempted?: (sessionId: string) => void
  onNamingError?: (scope: string, error: unknown) => void
  onConversationNameCleared?: (sessionId: string) => void
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
}

export function createStructuredClaudeRuntimeAdapter(
  deps: StructuredClaudeRuntimeAdapterDeps
): ClaudeStructuredSessionAdapter {
  const { store } = deps
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: createClaudeStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveCommand: deps.resolveClaudeCommand ?? resolveClaudeCommand,
      ...(deps.resolveClaudeLaunchEnv ? { resolveEnv: deps.resolveClaudeLaunchEnv } : {}),
      resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
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
    readTranscriptLeaf: async ({
      providerSessionId,
      previousLeafUuid,
      intentionalRewindUuid,
      claudeConfigDir
    }) => {
      const transcriptPath = await resolveSessionFilePath('claude', providerSessionId, {
        claudeProjectsDir: join(claudeConfigDir, 'projects')
      })
      if (transcriptPath && intentionalRewindUuid !== undefined) {
        return (
          await proveClaudeTranscriptBranch({
            transcriptPath,
            providerSessionId,
            previousLeafUuid,
            intentionalRewindUuid
          })
        ).leafUuid
      }
      return transcriptPath
        ? await readClaudeTranscriptLeafUuid(transcriptPath, providerSessionId, previousLeafUuid)
        : null
    },
    ...(deps.onConversationName ? { onConversationName: deps.onConversationName } : {}),
    ...(deps.readNamingState ? { readNamingState: deps.readNamingState } : {}),
    ...(deps.markNamingAttempted ? { markNamingAttempted: deps.markNamingAttempted } : {}),
    ...(deps.onNamingError ? { onNamingError: deps.onNamingError } : {}),
    ...(deps.onConversationNameCleared
      ? { onConversationNameCleared: deps.onConversationNameCleared }
      : {}),
    readTranscriptConversationName: async ({ providerSessionId, claudeConfigDir }) => {
      const transcriptPath = await resolveSessionFilePath('claude', providerSessionId, {
        claudeProjectsDir: join(claudeConfigDir, 'projects')
      })
      // No transcript is no evidence either way, never a cleared name.
      return transcriptPath
        ? await readClaudeTranscriptConversationName(transcriptPath)
        : { kind: 'unknown' as const }
    },
    onEvent: (event) => {
      if (
        event.type === 'ended' &&
        event.cause === 'unexpected-exit' &&
        event.fence !== undefined &&
        event.acquisitionGeneration
      ) {
        deps.onUnexpectedExit({
          type: 'ended',
          sessionId: event.sessionId,
          reason: event.reason,
          cause: event.cause,
          fence: event.fence,
          acquisitionGeneration: event.acquisitionGeneration,
          ...(event.settlementRetryRequired
            ? { settlementRetryRequired: event.settlementRetryRequired }
            : {})
        })
      }
    },
    ...(deps.onBackgroundTasksChanged
      ? { onBackgroundTasksChanged: deps.onBackgroundTasksChanged }
      : {}),
    ...(deps.onDispatchSettledLate ? { onDispatchSettledLate: deps.onDispatchSettledLate } : {}),
    ...(deps.openClaudeConnection ? { openConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
  })
}

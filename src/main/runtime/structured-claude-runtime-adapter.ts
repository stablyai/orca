import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveClaudeCommand } from '../codex-cli/command'
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
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { ClaudeAtRestCommandCatalog } from '../claude/claude-at-rest-commands'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import type { ClaudeCliFlagSupport } from '../claude/claude-cli-flag-support'
import { prewarmClaudeCliFlags } from '../claude/claude-cli-flag-prewarm'

export type StructuredClaudeRuntimeAdapterDeps = {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** The registration's composed launch: the shared launch path with Claude's part. */
  resolveLaunch: ClaudeStructuredSessionAdapterDeps['resolveLaunch']
  /** The binary and env the startup version prewarm asks, as a launch would. */
  resolveClaudeCommand?: () => string
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** The env a Claude child inherits before auth stripping; absent inherits Orca's own. */
  resolveClaudeInheritedEnv?: () => Promise<Record<string, string>>
  /** Which version-gated flags a Claude CLI takes; absent never passes one. */
  claudeCliFlags?: ClaudeCliFlagSupport
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: ClaudeStructuredSessionAdapterDeps['readProcessStartTime']
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
  if (
    event.type === 'started' ||
    event.type === 'options-reported' ||
    event.type === 'options-skipped'
  ) {
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
      ...(event.startupUnproven ? { startupUnproven: event.startupUnproven } : {}),
      ...(event.startupUnanswered ? { startupUnanswered: event.startupUnanswered } : {})
    }
  }
  return null
}

export function createStructuredClaudeRuntimeAdapter(
  deps: StructuredClaudeRuntimeAdapterDeps
): ClaudeStructuredSessionAdapter {
  const { store } = deps
  if (deps.claudeCliFlags) {
    // Before any chat launches, so the first one rarely waits on the version check.
    void prewarmClaudeCliFlags({
      cliFlags: deps.claudeCliFlags,
      store,
      resolveCommand: deps.resolveClaudeCommand ?? resolveClaudeCommand,
      ...(deps.resolveClaudeLaunchEnv ? { resolveEnv: deps.resolveClaudeLaunchEnv } : {}),
      ...(deps.resolveClaudeInheritedEnv
        ? { resolveInheritedEnv: deps.resolveClaudeInheritedEnv }
        : {})
    })
  }
  return new ClaudeStructuredSessionAdapter({
    atRestCommands: new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: deps.resolveWorkspacePath
    }),
    resolveLaunch: deps.resolveLaunch,
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
    ...openClaudeConnectionOf(deps),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
  })
}

/** The child's connection, watched for a CLI refusing a version-gated flag, so the start that
 *  failed on it is the last one to pass it. */
export function openClaudeConnectionOf(
  deps: Pick<StructuredClaudeRuntimeAdapterDeps, 'openClaudeConnection' | 'claudeCliFlags'>
): Pick<ClaudeStructuredSessionAdapterDeps, 'openConnection'> {
  const support = deps.claudeCliFlags
  if (!support) {
    return deps.openClaudeConnection ? { openConnection: deps.openClaudeConnection } : {}
  }
  const open = deps.openClaudeConnection ?? openClaudeStreamJsonConnection
  return {
    openConnection: (launch, handlers = {}, ...rest) =>
      open(
        launch,
        {
          ...handlers,
          // Every argument passes through, so one the connection adds later still reaches the session.
          onExit: (...args) => {
            support.observeExit(
              { command: launch.pathToClaudeCodeExecutable, cwd: launch.cwd },
              args[0]
            )
            handlers.onExit?.(...args)
          }
        },
        ...rest
      )
  }
}

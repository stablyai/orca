import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveClaudeCommand } from '../codex-cli/command'
import { ClaudeStructuredSessionAdapter } from '../claude/claude-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from '../claude/structured/claude-structured-session-state'
import { claudeProviderHandleLink } from '../claude/structured/claude-structured-owner-identity'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

import {
  recordAgentSessionProviderHandle,
  reviseAgentSessionProviderResumePoint
} from './agent-session/ownership/agent-session-provider-handle-transition'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  ClaudeAtRestCommandCatalog,
  type ClaudeAtRestCommandsDeps
} from '../claude/claude-at-rest-commands'
import type { ClaudeCommandCatalogProbe } from '../claude/claude-command-catalog-probe'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import type { ClaudeCliFlagSupport } from '../claude/claude-cli-flag-support'
import { prewarmClaudeCliFlags } from '../claude/claude-cli-flag-prewarm'

export type StructuredClaudeRuntimeAdapterDeps = {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveAccountHome?: ClaudeAtRestCommandsDeps['resolveAccountHome']
  resolveLaunch: ClaudeStructuredSessionAdapterDeps['resolveLaunch']
  /** The binary and env the startup version prewarm asks, as a launch would. */
  resolveClaudeCommand?: typeof resolveClaudeCommand
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** The env a Claude child inherits before auth stripping; absent inherits Orca's own. */
  resolveClaudeInheritedEnv?: () => Promise<Record<string, string>>
  /** Asks Claude for a chat's `/` menu while it isn't running; absent reads the folders. */
  atRestCommandProbe?: ClaudeCommandCatalogProbe
  /** Which version-gated flags a Claude CLI takes; absent never passes one. */
  claudeCliFlags?: ClaudeCliFlagSupport
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: ClaudeStructuredSessionAdapterDeps['readProcessStartTime']
  onLifecycleEvent: (event: StructuredAgentSessionLifecycleEvent) => void
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
  onChildWorkEvidence?: ClaudeStructuredSessionAdapterDeps['onChildWorkEvidence']
  logger?: ClaudeStructuredSessionAdapterDeps['logger']
}

/** The adapter events the host's lifecycle handler consumes, in the host's vocabulary. */
export function structuredClaudeLifecycleEvent(
  event: ClaudeStructuredSessionEvent
): StructuredAgentSessionLifecycleEvent | null {
  if (event.type === 'options-reported') {
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
      ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt })
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
      resolveWorkspacePath: deps.resolveWorkspacePath,
      ...(deps.resolveAccountHome ? { resolveAccountHome: deps.resolveAccountHome } : {}),
      ...(deps.atRestCommandProbe ? { probe: deps.atRestCommandProbe } : {})
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
    ...(deps.onChildWorkEvidence ? { onChildWorkEvidence: deps.onChildWorkEvidence } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...openClaudeConnectionOf(deps),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
  })
}

/** Watch flag-refusal exits so the next start omits the unsupported flag. */
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

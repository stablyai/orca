import { agentSessionProviderRemoteControlsEqual } from '../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { StructuredAgentSessionProviderRemoteControlEvent } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-provider-remote-control-event'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../claude-structured-session-state'
import {
  advanceClaudeRemoteControl,
  claudeRemoteControlView,
  CLAUDE_REMOTE_CONTROL_OFF,
  type ClaudeRemoteControlEvent
} from './claude-remote-control-machine'

export type ClaudeRemoteControlLinkDeps = {
  sessionId: string
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
  report: (event: StructuredAgentSessionProviderRemoteControlEvent) => void
}

export function claudeRemoteControlLinkDeps(
  sessionId: string,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'logger'>,
  report: ClaudeRemoteControlLinkDeps['report']
): ClaudeRemoteControlLinkDeps {
  return {
    sessionId,
    report,
    ...(deps.requestTimeoutMs === undefined ? {} : { timeoutMs: deps.requestTimeoutMs }),
    ...(deps.logger ? { logger: deps.logger } : {})
  }
}

/** Feeds one event to this process's link, sends what it asks for, and reports what clients see. */
export function driveClaudeRemoteControl(
  session: ClaudeSession,
  event: ClaudeRemoteControlEvent,
  deps: ClaudeRemoteControlLinkDeps
): void {
  const before = session.remoteControl ?? CLAUDE_REMOTE_CONTROL_OFF
  const { phase, effect } = advanceClaudeRemoteControl(before, event)
  session.remoteControl = phase
  const shown = claudeRemoteControlView(phase)
  if (!agentSessionProviderRemoteControlsEqual(claudeRemoteControlView(before), shown)) {
    deps.report({
      type: 'provider-remote-control',
      sessionId: deps.sessionId,
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      remoteControl: shown ?? null
    })
  }
  if (!effect) {
    return
  }
  const send = session.connection.remoteControl
  const enabled = effect.kind === 'enable'
  ;(send ? send(enabled, { timeoutMs: deps.timeoutMs }) : Promise.reject(new Error('unsupported')))
    .then((answer) => {
      if (!session.connection.closed) {
        driveClaudeRemoteControl(
          session,
          enabled
            ? { type: 'answered', generation: effect.generation, ...answer }
            : { type: 'disconnected', generation: effect.generation },
          deps
        )
      }
    })
    .catch((error: unknown) => {
      if (session.connection.closed) {
        return
      }
      deps.logger?.warn(
        enabled
          ? 'connecting a Claude chat to Remote Control failed'
          : 'disconnecting a Claude chat from Remote Control failed',
        { scope: 'claude-remote-control', sessionId: deps.sessionId, error }
      )
      const detail = error instanceof Error ? error.message : String(error)
      driveClaudeRemoteControl(
        session,
        enabled
          ? { type: 'refused', generation: effect.generation, detail }
          : { type: 'disconnect-refused', generation: effect.generation },
        deps
      )
    })
}

/** A `system`/`bridge_state` frame from this process, or null for any other frame. */
export function claudeBridgeStateEvent(
  frame: Record<string, unknown>
): Extract<ClaudeRemoteControlEvent, { type: 'bridge' }> | null {
  if (
    frame.type !== 'system' ||
    frame.subtype !== 'bridge_state' ||
    typeof frame.state !== 'string'
  ) {
    return null
  }
  return {
    type: 'bridge',
    state: frame.state,
    ...(typeof frame.detail === 'string' && frame.detail ? { detail: frame.detail } : {})
  }
}

/** A chat still starting applies the saved choice itself once its catch-up is done. */
export function setClaudeSessionRemoteControl(
  session: ClaudeSession | undefined,
  enabled: boolean,
  sessionId: string,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'logger'>,
  emit: (session: ClaudeSession, event: StructuredAgentSessionProviderRemoteControlEvent) => void
): boolean {
  if (!session || session.connection.closed || !session.initialization.startup.opened()) {
    return false
  }
  driveClaudeRemoteControl(
    session,
    enabled ? { type: 'connect', enabledByDefault: false } : { type: 'disconnect' },
    claudeRemoteControlLinkDeps(sessionId, deps, (event) => emit(session, event))
  )
  return true
}

export function observeClaudeBridgeState(
  session: ClaudeSession,
  frame: Record<string, unknown>,
  sessionId: string,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'logger'>,
  emit: (session: ClaudeSession, event: StructuredAgentSessionProviderRemoteControlEvent) => void
): void {
  const bridge = claudeBridgeStateEvent(frame)
  if (bridge) {
    driveClaudeRemoteControl(
      session,
      bridge,
      claudeRemoteControlLinkDeps(sessionId, deps, (event) => emit(session, event))
    )
  }
}

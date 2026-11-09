import { defineMethod, type RpcContext } from '../../core'
import {
  TURN_SENDER_METHOD,
  type TurnSenderResult
} from '../../../../../shared/remote-runtime/pairing/turn-sender-contract'
import {
  agentSessionSenderKey,
  drivingDeviceFor,
  terminalSenderKey
} from '../../../sender/driving-device-registry'

/**
 * A plain terminal (no agent launch token): its handle and pane key must name the same live PTY.
 * Terminals that were launched with a token must prove it (verifyOrchestrationCompatibilityCaller).
 */
function plainTerminalHandle(ctx: RpcContext): string | null {
  const evidence = ctx.orchestrationCompatibilityEvidence
  const handle = typeof evidence?.terminalHandle === 'string' ? evidence.terminalHandle.trim() : ''
  const paneKey = typeof evidence?.paneKey === 'string' ? evidence.paneKey.trim() : ''
  if (!handle || !paneKey || evidence?.host) {
    return null
  }
  const terminal = ctx.runtime.getOrchestrationDispatchAuthority(handle)
  return terminal && !terminal.launchTokenHash && terminal.paneKey === paneKey ? handle : null
}

/**
 * Who drove me? For an agent's own tools: the caller is the terminal or structured session orcad
 * attests from its launch evidence, so one agent can never read (or claim) another agent's sender.
 */
function turnSender(ctx: RpcContext): TurnSenderResult {
  // Agents reach orcad through the local CLI only; paired devices are people, not agents.
  if (ctx.caller?.kind !== 'local-cli') {
    return { caller: null, sender: null }
  }
  if (ctx.orchestrationCaller?.sessionId) {
    const sessionId = ctx.orchestrationCaller.sessionId
    return {
      caller: { kind: 'session', sessionId },
      sender: drivingDeviceFor(agentSessionSenderKey(sessionId))
    }
  }
  const authority = ctx.runtime.verifyOrchestrationCompatibilityCaller(
    ctx.orchestrationCompatibilityEvidence
  )
  const handle = authority?.terminalHandle ?? plainTerminalHandle(ctx)
  if (!handle) {
    return { caller: null, sender: null }
  }
  return {
    caller: { kind: 'terminal', handle },
    sender: drivingDeviceFor(terminalSenderKey(handle))
  }
}

export const ORCHESTRATION_TURN_SENDER_METHODS = [
  defineMethod({
    name: TURN_SENDER_METHOD,
    permission: 'workspace',
    params: null,
    handler: (_params, ctx): TurnSenderResult => turnSender(ctx)
  })
]

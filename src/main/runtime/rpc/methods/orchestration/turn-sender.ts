import type { RpcContext } from '../../core'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
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
 * The terminal an agent's own CLI call came from, as orcad attests it: a token-launched terminal
 * proves its launch token, a plain one must match handle and pane key. Never read from params.
 */
export function verifiedCallerTerminalHandle(ctx: RpcContext): string | null {
  // Agents reach orcad through the local CLI only; paired devices are people, not agents.
  if (ctx.caller?.kind !== 'local-cli') {
    return null
  }
  const authority = ctx.runtime.verifyOrchestrationCompatibilityCaller(
    ctx.orchestrationCompatibilityEvidence
  )
  return authority?.terminalHandle ?? plainTerminalHandle(ctx)
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
  const orchestrationCaller = ctx.orchestrationCaller
  // A paired Orca coordinating a Run here is not an agent session on this host.
  if (orchestrationCaller && orchestrationCaller.kind !== 'peer') {
    const sessionId = orchestrationCaller.sessionId
    return {
      caller: { kind: 'session', sessionId },
      sender: drivingDeviceFor(agentSessionSenderKey(sessionId))
    }
  }
  const handle = verifiedCallerTerminalHandle(ctx)
  if (!handle) {
    return { caller: null, sender: null }
  }
  return {
    caller: { kind: 'terminal', handle },
    sender: drivingDeviceFor(terminalSenderKey(handle))
  }
}

export const ORCHESTRATION_TURN_SENDER_METHODS = [
  defineOrchestrationMethod({
    name: TURN_SENDER_METHOD,
    // The caller reads only its own sender, attested by orcad; nothing is addressed by params.
    access: { kind: 'reads', targets: {} },
    permission: 'workspace',
    params: null,
    handler: (_params, ctx): TurnSenderResult => turnSender(ctx)
  })
]

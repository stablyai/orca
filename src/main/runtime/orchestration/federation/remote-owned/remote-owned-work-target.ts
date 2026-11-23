import {
  sanitizeWorkTargetLabel,
  toPeerLocalWorkTargetPlacement,
  type ResolvedBotWorkTargetPlacement
} from '../../../../../shared/agent-session/work-target/agent-session-work-target'
import {
  activeBotWorkTargetForCaller,
  assertBotWorkTargetPairingRevision,
  describeExpectedPlacementFlags
} from '../../../../bots/bot-turn-work-target'
import { isWorkTargetFollowUpMessageType } from '../../../../bots/bot-work-target-workspace-match'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../../rpc/core'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  getRemoteRunLink,
  remoteRunLinkPinMatches,
  remoteServerPin,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'
import { OrchestrationError } from '../../orchestration-error'
import { serverSupportsWorkTargetFollowUp } from './remote-owned-start'

/**
 * Enforce active turn target, pairing identity, and capability support before forwarding
 * a work-delegating `orchestration.send` to a paired remote-owned worker.
 */
export async function resolveRemoteOwnedFollowUpWorkTarget(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  ctx: RpcContext
  method: string
  messageType: string | undefined
  subject: { link: RemoteRunLinkRow; dispatchId?: string }
}): Promise<ResolvedBotWorkTargetPlacement | undefined> {
  const { runtime, db, ctx, method, messageType, subject } = args
  if (
    method !== 'orchestration.send' ||
    !subject.dispatchId ||
    !isWorkTargetFollowUpMessageType(messageType)
  ) {
    return undefined
  }
  const workTarget = activeBotWorkTargetForCaller(runtime.botWorkTargets, ctx.orchestrationCaller)
  if (!workTarget) {
    return undefined
  }
  const label = sanitizeWorkTargetLabel(workTarget.canonicalTarget.displayName)
  const expectedFlags = describeExpectedPlacementFlags(workTarget)
  const guidance = expectedFlags
    ? ` Start a worker with \`orca orchestration worker-start ${expectedFlags}\` instead.`
    : ''
  const workerLabel = `dispatch:${subject.dispatchId}`
  if (!workTarget.onEnvironmentId) {
    throw new OrchestrationError(
      'invalid_argument',
      `This turn targets "${label}" on this host, but ${workerLabel} runs on a paired server.${guidance} No effects were applied.`,
      { effectsApplied: false }
    )
  }
  if (workTarget.onEnvironmentId !== subject.link.environment_id) {
    throw new OrchestrationError(
      'invalid_argument',
      `This turn targets "${label}" on paired server "${workTarget.canonicalTarget.hostLabel ?? workTarget.onEnvironmentId}", not the server running ${workerLabel}.${guidance} No effects were applied.`,
      { effectsApplied: false }
    )
  }
  let server: Awaited<ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>>
  try {
    server = await runtime.resolveOrchestrationWorkerServer(subject.link.environment_id)
  } catch {
    throw new OrchestrationError(
      'server_pairing_changed',
      `The paired server for ${workerLabel} is no longer available under the validated pairing. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  assertBotWorkTargetPairingRevision(server, workTarget)
  const currentLink = getRemoteRunLink(db, subject.link.conversation_id)
  if (!currentLink || currentLink.state !== 'open') {
    throw new OrchestrationError(
      'remote_link_closed',
      `The remote Run link on ${server.name} is no longer open for ${workerLabel}. No effects were applied.`,
      { effectsApplied: false, server: server.name }
    )
  }
  const serverPin = remoteServerPin(server)
  if (
    !remoteRunLinkPinMatches(currentLink, serverPin) ||
    !remoteRunLinkPinMatches(subject.link, serverPin)
  ) {
    throw new OrchestrationError(
      'server_pairing_changed',
      `The pairing with ${server.name} was re-made, so it no longer matches ${workerLabel}. No effects were applied.`,
      { effectsApplied: false, server: server.name }
    )
  }
  if (!(await serverSupportsWorkTargetFollowUp(runtime, server))) {
    throw new OrchestrationError(
      'capability_unsupported',
      `This turn targets "${label}". Paired server ${server.name} needs an Orca update to verify follow-up work on ${workerLabel} against the selected target; update ${server.name} or start a worker with \`orca orchestration worker-start ${expectedFlags}\`. No effects were applied.`,
      { effectsApplied: false, server: server.name }
    )
  }
  return toPeerLocalWorkTargetPlacement(workTarget)
}

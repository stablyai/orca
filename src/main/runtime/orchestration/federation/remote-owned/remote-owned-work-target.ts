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
import type { OrchestrationMethodAccessDeclaration } from '../../../rpc/methods/orchestration/access/orchestration-method-access'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  getRemoteRunLink,
  remoteRunLinkPinMatches,
  remoteServerPin,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationWorkerServer } from '../environment-transport'
import type { RemoteForwardKey } from './remote-forward-caller'
import { forwardToRemoteOwnedLink } from './remote-owned-forward'
import {
  invalidateWorkTargetFollowUpCapability,
  resolveWorkTargetFollowUpCapability
} from './remote-owned-start'

type RemoteFollowUpSubject = { link: RemoteRunLinkRow; dispatchId?: string }

function unsupportedFollowUpError(
  serverName: string,
  label: string,
  workerLabel: string,
  expectedFlags: string
): OrchestrationError {
  return new OrchestrationError(
    'capability_unsupported',
    `This turn targets "${label}". Paired server ${serverName} needs an Orca update to verify follow-up work on ${workerLabel} against the selected target; update ${serverName} or start a worker with \`orca orchestration worker-start ${expectedFlags}\`. No effects were applied.`,
    { effectsApplied: false, server: serverName }
  )
}

function runtimeChangedError(serverName: string, detail: string): OrchestrationError {
  return new OrchestrationError(
    'runtime_environment_changed',
    `${detail} No effects were applied.`,
    {
      effectsApplied: false,
      server: serverName
    }
  )
}

async function validateServerAndOpenLink(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  subject: RemoteFollowUpSubject
  workTarget: ResolvedBotWorkTargetPlacement
  label: string
  workerLabel: string
  guidance: string
}): Promise<OrchestrationWorkerServer> {
  const { runtime, db, subject, workTarget, label, workerLabel, guidance } = args
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
  let server: OrchestrationWorkerServer
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
  return server
}

async function resolvePinnedFollowUpRuntimeId(args: {
  runtime: OrcaRuntimeService
  server: OrchestrationWorkerServer
  label: string
  workerLabel: string
  expectedFlags: string
  force?: true
}): Promise<string> {
  const { runtime, server, label, workerLabel, expectedFlags, force } = args
  let capability: { supported: boolean; runtimeId: string | null }
  try {
    capability = await resolveWorkTargetFollowUpCapability(
      runtime,
      server,
      force ? { force: true } : undefined
    )
  } catch (probeError) {
    if (
      probeError instanceof OrchestrationError &&
      (probeError.code === 'capability_unsupported' ||
        probeError.code === 'server_pairing_changed' ||
        probeError.code === 'runtime_environment_changed')
    ) {
      throw probeError
    }
    const detail = probeError instanceof Error ? probeError.message : String(probeError)
    throw runtimeChangedError(
      server.name,
      `Could not verify the runtime instance of paired server ${server.name} for "${label}" (${detail}).`
    )
  }
  if (!capability.runtimeId) {
    throw runtimeChangedError(
      server.name,
      `Paired server ${server.name} did not report a verifiable runtime instance for "${label}".`
    )
  }
  if (!capability.supported) {
    throw unsupportedFollowUpError(server.name, label, workerLabel, expectedFlags)
  }
  return capability.runtimeId
}

/**
 * Enforce active turn target, pairing identity, and runtime-instance-pinned capability support
 * for a work-delegating `orchestration.send` to a paired remote-owned worker.
 * Returns `{ handled: false }` for untargeted turns or non-work calls so existing routing stays unchanged.
 */
export async function forwardRemoteOwnedWithWorkTarget(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  ctx: RpcContext
  method: string
  access: OrchestrationMethodAccessDeclaration
  values: Record<string, unknown>
  messageType: string | undefined
  subject: RemoteFollowUpSubject
  forward?: RemoteForwardKey
  onAnswer?: (answer: unknown) => void
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const { runtime, db, ctx, method, access, values, messageType, subject, forward, onAnswer } = args
  if (
    method !== 'orchestration.send' ||
    !subject.dispatchId ||
    !isWorkTargetFollowUpMessageType(messageType)
  ) {
    return { handled: false }
  }
  const workTarget = activeBotWorkTargetForCaller(runtime.botWorkTargets, ctx.orchestrationCaller)
  if (!workTarget) {
    return { handled: false }
  }
  const label = sanitizeWorkTargetLabel(workTarget.canonicalTarget.displayName)
  const expectedFlags = describeExpectedPlacementFlags(workTarget)
  const guidance = expectedFlags
    ? ` Start a worker with \`orca orchestration worker-start ${expectedFlags}\` instead.`
    : ''
  const workerLabel = `dispatch:${subject.dispatchId}`
  const server = await validateServerAndOpenLink({
    runtime,
    db,
    subject,
    workTarget,
    label,
    workerLabel,
    guidance
  })
  const initialRuntimeId = await resolvePinnedFollowUpRuntimeId({
    runtime,
    server,
    label,
    workerLabel,
    expectedFlags
  })
  const peerWorkTarget = toPeerLocalWorkTargetPlacement(workTarget)
  try {
    return {
      handled: true,
      result: await forwardToRemoteOwnedLink(runtime, subject, method, access, values, {
        forward,
        peerWorkTarget,
        expectedEnvironmentRuntimeId: initialRuntimeId,
        onAnswer
      })
    }
  } catch (error) {
    if (!(error instanceof OrchestrationError && error.code === 'runtime_environment_changed')) {
      throw error
    }
    invalidateWorkTargetFollowUpCapability(runtime, server, initialRuntimeId)
    const refreshedServer = await validateServerAndOpenLink({
      runtime,
      db,
      subject,
      workTarget,
      label,
      workerLabel,
      guidance
    })
    const refreshedRuntimeId = await resolvePinnedFollowUpRuntimeId({
      runtime,
      server: refreshedServer,
      label,
      workerLabel,
      expectedFlags,
      force: true
    })
    if (refreshedRuntimeId === initialRuntimeId) {
      invalidateWorkTargetFollowUpCapability(runtime, refreshedServer, refreshedRuntimeId)
      throw runtimeChangedError(
        refreshedServer.name,
        `Paired server ${refreshedServer.name} reported an unchanged runtime instance after rejecting "${label}".`
      )
    }
    try {
      return {
        handled: true,
        result: await forwardToRemoteOwnedLink(runtime, subject, method, access, values, {
          forward,
          peerWorkTarget,
          expectedEnvironmentRuntimeId: refreshedRuntimeId,
          onAnswer
        })
      }
    } catch (retryError) {
      if (
        retryError instanceof OrchestrationError &&
        retryError.code === 'runtime_environment_changed'
      ) {
        invalidateWorkTargetFollowUpCapability(runtime, refreshedServer, refreshedRuntimeId)
        throw runtimeChangedError(
          refreshedServer.name,
          `Paired server ${refreshedServer.name} changed runtime instance again while sending work for "${label}"; retry once ${refreshedServer.name} stabilizes.`
        )
      }
      throw retryError
    }
  }
}

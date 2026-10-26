/** Deploy empty hosts, migrate source state, or connect/update managed hosts when terminal safety permits. Publish explicit unserved reasons on refusal; use stdio when sshd blocks forwarding. */
import type {
  OrcadManagedConversionResult,
  OrcadManagedDeployResult
} from '../../shared/orcad-managed-runtime'
import type {
  SshManagedServerRelayReason,
  SshManagedServerLinkedProject,
  SshManagedServerNodeDownloadBlocked,
  SshManagedServerServingNote,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import type { OrcadManagedServing } from '../managed-server/lifecycle/orcad-managed-serving'
import {
  checkManagedServerUpdate,
  type ManagedServerUpdateDeps
} from './managed-server-update-check'
import { managedResultAfterUpdate, unservedManagedResult } from './managed-server-serving-gate'
import { keptForBridgedTerminals, relayTerminalReason } from './ssh-host-server-bridged-unserved'
import { deferred, setupFailed } from './ssh-host-server-setup-outcome'
import {
  classifyOrcadHostUnavailable,
  ORCAD_TUNNEL_UNAVAILABLE_REASON
} from '../orcad/orcad-host-unavailable'
import {
  decidedEvent,
  reportHostServerConversion,
  reportHostServerDeploy,
  reportHostServerEvent,
  startHostServerDecisionTrace,
  type HostServerDecisionTrace,
  type HostServerReport
} from './ssh-host-server-connect-events'

type HostServerPhase = 'deploying' | 'converting' | 'connecting' | 'updating' | 'starting'

export type HostServerOnConnectResult =
  | {
      route: 'managed'
      environmentId: string
      update?: SshManagedServerUpdateNote
      serving?: SshManagedServerServingNote
      linked?: SshManagedServerLinkedProject[]
      /** Another desktop's update held the host; recheck until it clears. Never published. */
      fenceHeld?: true
    }
  | {
      route: 'unserved'
      reason: SshManagedServerRelayReason
      detail?: string
      terminals?: number
      terminalsElsewhere?: boolean
      canLeaveBehind?: true
      /** A move that stopped short kept the host locked; the next connect resumes it. */
      held?: true
      /** Setup lost contact with the host, so it is not known to have failed there. */
      contactLost?: true
      nodeDownloadBlocked?: SshManagedServerNodeDownloadBlocked
      /** COMPAT(legacy-relay-bridge): the connect stays up so the bridge serves the terminals. */
      bridged?: true
    }

export type HostServerTerminalVerdict = {
  verdict: 'exited' | 'live' | 'unverifiable'
  count: number
  /** Counted only by the host-wide census: another desktop or session runs them. */
  elsewhere?: boolean
  /** COMPAT(legacy-relay-bridge): the host converts anyway and the bridge serves them. */
  bridged?: true
}

export type HostServerOnConnectDeps = {
  managedEnvironmentId: (target: SshTarget) => string | null
  ensureTunnel: (environmentId: string) => Promise<void>
  /** Wake only on proven stopped activation, then verify serving behind the tunnel. */
  ensureServing: (environmentId: string) => Promise<OrcadManagedServing>
  /** Finish retained-source bookkeeping after late commit replies without deleting source rows. */
  retainCommittedSource: (target: SshTarget) => Promise<void>
  hasTemplate: () => boolean
  recordedUnavailable: (target: SshTarget) => string | null
  recordUnavailable: (target: SshTarget, reason: string) => void
  isEmptyHost: (target: SshTarget) => boolean
  relayTerminals: (target: SshTarget) => Promise<HostServerTerminalVerdict>
  deploy: (target: SshTarget) => Promise<OrcadManagedDeployResult>
  /** Reuse the connect's pre-session terminal proof when available. */
  convert: (
    target: SshTarget,
    hostProof: HostServerTerminalVerdict | null
  ) => Promise<OrcadManagedConversionResult>
  hasUnfinishedConversion: (target: SshTarget) => boolean
  /** Releases a conversion fence once its server provably holds nothing. */
  abandonConversion: (target: SshTarget) => Promise<void>
  /** Releases an empty-host deploy claim whose server was never registered. */
  abandonDeploy: (target: SshTarget) => Promise<void>
  progress: (target: SshTarget, phase: HostServerPhase) => void
  /** A conversion fenced the host and registered its server, but staged nothing there yet. */
  isFencedBeforeStaging: (target: SshTarget) => boolean
  /** Unregisters that unreachable server and releases its fence, leaving the host unmoved. */
  releaseUnreachableSetup: (target: SshTarget) => Promise<void>
  report: HostServerReport
} & ManagedServerUpdateDeps

export async function resolveHostServerOnConnect(
  target: SshTarget,
  deps: HostServerOnConnectDeps
): Promise<HostServerOnConnectResult> {
  const trace = startHostServerDecisionTrace()
  let result: HostServerOnConnectResult | null = null
  try {
    result = await decide(target, deps, trace)
    return result
  } finally {
    reportHostServerEvent(deps.report, target, decidedEvent(result, trace))
  }
}

async function decide(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  trace: HostServerDecisionTrace
): Promise<HostServerOnConnectResult> {
  if (target.orcadFence?.sourceChangedAt) {
    return { route: 'unserved', reason: 'source_changed' }
  }
  const existing = deps.managedEnvironmentId(target)
  if (existing) {
    trace.path = 'existing'
    deps.progress(target, 'connecting')
    try {
      await deps.ensureTunnel(existing)
    } catch (error) {
      // Before staging only: once remote state exists, destination evidence must resolve it.
      if (
        classifyOrcadHostUnavailable(error) === ORCAD_TUNNEL_UNAVAILABLE_REASON &&
        deps.isFencedBeforeStaging(target)
      ) {
        await deps.releaseUnreachableSetup(target)
        deps.recordUnavailable(target, ORCAD_TUNNEL_UNAVAILABLE_REASON)
        return {
          route: 'unserved',
          reason: 'orcad_unavailable',
          detail: ORCAD_TUNNEL_UNAVAILABLE_REASON
        }
      }
      throw error
    }
    if (deps.hasUnfinishedConversion(target)) {
      // Finish/abort unfinished conversion before routing; registration alone proves no durable catalog.
      return await convertHost(target, deps, trace, { checkTerminals: false })
    }
    const serving = await deps.ensureServing(existing)
    const unserved = unservedManagedResult(existing, serving)
    if (unserved) {
      return unserved
    }
    try {
      await deps.retainCommittedSource(target)
    } catch (error) {
      console.warn('[ssh] Could not mark a finished migration retained:', error)
    }
    const update = await checkManagedServerUpdate(target, existing, deps, () =>
      deps.progress(target, 'updating')
    )
    trace.update = update.reason
    trace.recorded = update.recorded
    return managedResultAfterUpdate(existing, serving, update)
  }
  const recorded = deps.recordedUnavailable(target)
  if (recorded) {
    trace.recorded = true
    return { route: 'unserved', reason: 'orcad_unavailable', detail: recorded }
  }
  if (!deps.hasTemplate()) {
    return { route: 'unserved', reason: 'orcad_unavailable', detail: 'artifacts_unavailable' }
  }
  if (deps.isEmptyHost(target)) {
    try {
      trace.path = 'deploy'
      deps.progress(target, 'deploying')
      const deployed = await deps.deploy(target)
      reportHostServerDeploy(deps.report, target, trace, deployed)
      return await afterDeploy(target, deps, trace, deployed)
    } catch (error) {
      return setupFailed(target, deps, trace, error, true)
    }
  }
  return convertHost(target, deps, trace, { checkTerminals: true })
}

async function convertHost(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  trace: HostServerDecisionTrace,
  options: { checkTerminals: boolean }
): Promise<HostServerOnConnectResult> {
  let terminals: HostServerTerminalVerdict | null = null
  try {
    terminals = options.checkTerminals ? await deps.relayTerminals(target) : null
    if (terminals && terminals.verdict !== 'exited' && !terminals.bridged) {
      // Lost contact cannot prove relay terminals exited.
      return {
        route: 'unserved',
        reason: relayTerminalReason(terminals.verdict),
        terminals: terminals.count,
        ...(terminals.elsewhere ? { terminalsElsewhere: true } : {})
      }
    }
    trace.path = 'convert'
    trace.conversionStartedAt = Date.now()
    reportHostServerEvent(deps.report, target, { kind: 'conversion', phase: 'started' })
    deps.progress(target, 'converting')
    const converted = await deps.convert(target, terminals)
    if (converted.outcome === 'refused') {
      trace.refusal = converted.code
    }
    reportHostServerConversion(deps.report, target, trace, converted)
    return await afterConversion(target, deps, converted)
  } catch (error) {
    // COMPAT(legacy-relay-bridge): the terminals run on in their old tabs until they exit.
    const failed = await setupFailed(target, deps, trace, error, false)
    return keptForBridgedTerminals(failed, terminals, error)
  }
}

async function afterDeploy(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  trace: HostServerDecisionTrace,
  result: OrcadManagedDeployResult
): Promise<HostServerOnConnectResult> {
  if (result.outcome === 'deferred') {
    return deferred(target, deps, result, true)
  }
  const environmentId = result.environment.id
  if (result.outcome !== 'already-current') {
    return { route: 'managed', environmentId }
  }
  // Another Orca version may serve it; only the now-paired server can say whether it may update.
  const update = await checkManagedServerUpdate(target, environmentId, deps, () =>
    deps.progress(target, 'updating')
  )
  trace.update = update.reason
  trace.recorded = update.recorded
  return managedResultAfterUpdate(environmentId, { state: 'serving' }, update)
}

async function afterConversion(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  result: OrcadManagedConversionResult
): Promise<HostServerOnConnectResult> {
  switch (result.outcome) {
    case 'converted':
      return {
        route: 'managed',
        environmentId: result.environment.id,
        ...(result.linkedProjects ? { linked: result.linkedProjects } : {})
      }
    case 'deferred':
      return deferred(target, deps, result, false)
    case 'refused':
      if (result.code === 'orcad_migration_terminals') {
        return { route: 'unserved', reason: relayTerminalReason(result.verdict) }
      }
      return {
        route: 'unserved',
        reason: 'refused',
        detail: result.reason,
        ...(result.canLeaveBehind ? { canLeaveBehind: true } : {})
      }
  }
}

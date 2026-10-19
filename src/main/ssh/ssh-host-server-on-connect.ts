/**
 * Which server an SSH host runs, decided once per connect before any relay is started.
 *
 * Every host runs managed orcad: an empty host deploys it, a host with Orca state converts through
 * the journaled migration, and a converted host connects through its tunnel, updating first when
 * it runs an older build and its terminals allow. A host whose relay terminals are live, or can't
 * be proven exited, keeps the relay this session and converts on a later connect. A host orcad
 * can't run on keeps the pinned-relay ladder, with the reason recorded so the deploy isn't retried
 * on every connect. A host whose sshd refuses port forwarding reaches its server through the
 * stdio bridge (orcad-managed-tunnel-transport.ts) instead.
 */
import type {
  OrcadManagedConversionResult,
  OrcadManagedDeployResult
} from '../../shared/orcad-managed-runtime'
import type {
  SshManagedServerRelayReason,
  SshManagedServerLinkedProject,
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
import { orcadMigrationConflictGuidance } from './orcad-migration-conflict-guidance'
import { keptForBridgedTerminals, relayTerminalReason } from './ssh-host-server-bridged-unserved'
import { boundedDetail, setupFailure, type SetupFailure } from './ssh-host-server-setup-failure'
import {
  classifyOrcadHostUnavailable,
  ORCAD_TUNNEL_UNAVAILABLE_REASON
} from '../orcad/orcad-host-unavailable'
import {
  decidedEvent,
  reportHostServerConversion,
  reportHostServerDeploy,
  reportHostServerEvent,
  reportHostServerSetupError,
  startHostServerDecisionTrace,
  type HostServerDecisionTrace,
  type HostServerReport
} from './ssh-host-server-connect-events'

export type HostServerPhase = 'deploying' | 'converting' | 'connecting' | 'updating' | 'starting'

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
      /** A blocker the user must act on, or why orcad can't run on this host. */
      detail?: string
      terminals?: number
      terminalsElsewhere?: boolean
      canLeaveBehind?: true
      /** A move that stopped short kept the host locked; the next connect resumes it. */
      held?: true
      /** Setup lost contact with the host, so it is not known to have failed there. */
      contactLost?: true
      /** COMPAT(legacy-relay-bridge): the connect stays up so the bridge serves the terminals. */
      bridged?: true
    }

export type HostServerTerminalVerdict = {
  verdict: 'exited' | 'live' | 'unverifiable'
  /** Relay terminals known to be running or unproven. */
  count: number
  /** Counted only by the host-wide census: another desktop or session runs them. */
  elsewhere?: boolean
  /** COMPAT(legacy-relay-bridge): the host converts anyway and the bridge serves them. */
  bridged?: true
}

export type HostServerOnConnectDeps = {
  managedEnvironmentId: (target: SshTarget) => string | null
  ensureTunnel: (environmentId: string) => Promise<void>
  /** Behind the tunnel: answers, or is started from its activated slot if proven stopped. */
  ensureServing: (environmentId: string) => Promise<OrcadManagedServing>
  /** Marks a commit whose reply outlived the move as finished; its source rows are kept. */
  retainCommittedSource: (target: SshTarget) => void
  /** False when this build carries no orcad template, so nothing is tried on the host. */
  hasTemplate: () => boolean
  /** A recorded "orcad can't run here" whose key still matches this build. */
  recordedUnavailable: (target: SshTarget) => string | null
  recordUnavailable: (target: SshTarget, reason: string) => void
  /** True when the host holds no Orca state, so it deploys without a migration. */
  isEmptyHost: (target: SshTarget) => boolean
  relayTerminals: (target: SshTarget) => Promise<HostServerTerminalVerdict>
  deploy: (target: SshTarget) => Promise<OrcadManagedDeployResult>
  /** `hostProof`: the connect's own terminal verdict, for a conversion asked before any session. */
  convert: (
    target: SshTarget,
    hostProof: HostServerTerminalVerdict | null
  ) => Promise<OrcadManagedConversionResult>
  /** A registered server whose conversion has not committed and been kept yet. */
  hasUnfinishedConversion: (target: SshTarget) => boolean
  /** Releases a conversion fence once its server provably holds nothing, so the relay serves. */
  abandonConversion: (target: SshTarget) => Promise<void>
  /** Releases an empty-host deploy claim whose server was never registered. */
  abandonDeploy: (target: SshTarget) => Promise<void>
  progress: (target: SshTarget, phase: HostServerPhase) => void
  /** A conversion fenced the host and registered its server, but staged nothing there yet. */
  isFencedBeforeStaging: (target: SshTarget) => boolean
  /** Unregisters that unreachable server and releases its fence, so the relay serves again. */
  releaseUnreachableSetup: (target: SshTarget) => Promise<void>
  /** Receives each decision, conversion and deploy failure as raw codes for telemetry. */
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
      // Why only before staging: once the server holds staged state, only it can say what moved.
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
      // Why before routing: until the commit lands the server is empty, so finish it or back out.
      return await convertHost(target, deps, trace, { checkTerminals: false })
    }
    const serving = await deps.ensureServing(existing)
    const unserved = unservedManagedResult(existing, serving)
    if (unserved) {
      return unserved
    }
    try {
      deps.retainCommittedSource(target)
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
      // Why unverifiable too: loss of contact is never evidence that a relay terminal exited.
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

function setupFailed(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  trace: HostServerDecisionTrace,
  error: unknown,
  empty: boolean
): Promise<HostServerOnConnectResult> {
  console.warn('[ssh] Managed Orca server setup failed; using the relay this session:', error)
  reportHostServerSetupError(deps.report, target, trace, error)
  const unavailable = classifyOrcadHostUnavailable(error)
  const conflict = empty ? null : orcadMigrationConflictGuidance(error)
  if (conflict) {
    return unfinished(target, deps, unavailable, empty, 'refused', { detail: conflict })
  }
  return unfinished(target, deps, unavailable, empty, 'failed', setupFailure(error))
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

function deferred(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  result: { code: string; reason: string },
  empty: boolean
): Promise<HostServerOnConnectResult> {
  console.warn(`[ssh] Managed Orca server setup deferred (${result.code}):`, result.reason)
  const unavailable = classifyOrcadHostUnavailable({ code: result.code })
  return unfinished(target, deps, unavailable, empty, 'deferred', { detail: result.reason })
}

/**
 * A setup that stopped short: its claim or fence goes first, since a fenced host refuses the relay
 * and nothing remote serves it yet. A host orcad can't run on also records why.
 */
async function unfinished(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  unavailable: string | null,
  empty: boolean,
  reason: 'deferred' | 'failed' | 'refused',
  failure: SetupFailure
): Promise<HostServerOnConnectResult> {
  try {
    await (empty ? deps.abandonDeploy(target) : deps.abandonConversion(target))
  } catch (error) {
    // A staged or registered destination keeps its fence; the connect reports it below.
    console.warn('[ssh] The managed Orca server setup keeps its fence:', error)
  }
  // Why re-read: only the journal says whether the abort released the host or left it locked.
  const held = !empty && !unavailable && deps.hasUnfinishedConversion(target)
  if (!unavailable) {
    // Shown under the SSH host, with the host's orcad.log tail when the failure carries one.
    return {
      route: 'unserved',
      reason,
      detail: boundedDetail(failure.detail),
      ...(failure.contactLost ? { contactLost: true as const } : {}),
      ...(held ? { held: true as const } : {})
    }
  }
  deps.recordUnavailable(target, unavailable)
  return { route: 'unserved', reason: 'orcad_unavailable', detail: unavailable }
}

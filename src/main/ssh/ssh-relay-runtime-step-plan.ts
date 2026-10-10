/** Turns one ladder step into a relay plan, or a classified refusal the ladder steps past. */
import type { SshConnection } from './ssh-connection'
import { planHostNodeAddonRelay, type PrebuiltRelayPlan } from './ssh-relay-host-node-addons'
import {
  PinnedRelayFallbackError,
  planPinnedNodeRelay,
  resolvePinnedRelayTargetFacts
} from './ssh-relay-pinned-node'
import { rungBCompatRuntimeFor, type RelayRuntimeStep } from './ssh-relay-runtime-ladder'
import type { RelayRuntimeLadderRun } from './ssh-relay-runtime-resolution'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { RemoteNodeNotFoundError, resolveRemoteNodePath } from './ssh-remote-node-resolution'
import type { GlibcVersion, OrcadDeploymentTargetFacts } from './orcad-deployment-target'
import type { CompatServerTarget } from '../../shared/node-runtime-pin'

type StepPlanOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  baseVersion: string
  step: RelayRuntimeStep
  run: RelayRuntimeLadderRun
  signal?: AbortSignal
}

/** Resolved once per ladder pass; every rung above legacy keys on the same answer. */
async function ladderTargetFacts(options: StepPlanOptions): Promise<OrcadDeploymentTargetFacts> {
  const { run } = options
  run.facts ??= await resolvePinnedRelayTargetFacts(options)
  return run.facts
}

function planPinned(
  options: StepPlanOptions,
  facts: OrcadDeploymentTargetFacts,
  compat?: { target: CompatServerTarget; glibcFloor: GlibcVersion | null }
): Promise<PrebuiltRelayPlan> {
  const { conn, host, baseVersion, run, signal } = options
  return planPinnedNodeRelay({
    conn,
    host,
    baseVersion,
    signal,
    targetId: run.targetId,
    facts,
    persistedRefusal: (known) => run.persistedPinnedRefusal(known),
    compat
  })
}

/** Why strict: only an answered "no Node here" settles D; a lost probe stays a retryable failure. */
async function proveHostNodeForFallback(
  conn: SshConnection,
  host: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await resolveRemoteNodePath(conn, host, { signal, strict: true })
  } catch (error) {
    if (error instanceof RemoteNodeNotFoundError) {
      throw new PinnedRelayFallbackError('host_node_missing', 'no host Node.js 18+ with npm')
    }
    throw error
  }
}

/** Undefined for the host-npm path; throws `PinnedRelayFallbackError` when a rung cannot run. */
export async function planRelayRuntimeStep(
  options: StepPlanOptions
): Promise<PrebuiltRelayPlan | undefined> {
  const { conn, host, baseVersion, step, run, signal } = options
  run.host = host
  switch (step) {
    case 'legacy':
      if (run.laddered) {
        run.hostNodePath = await proveHostNodeForFallback(conn, host, signal)
      }
      return undefined
    case 'A':
      return planPinned(options, await ladderTargetFacts(options))
    case 'B': {
      if (host.os === 'win32') {
        throw new PinnedRelayFallbackError(
          'runtime_unavailable',
          'no compat runtime serves Windows'
        )
      }
      const facts = await ladderTargetFacts(options)
      // run.lastRefusal is rung A's: B is entered only by stepping down from A.
      const compat = rungBCompatRuntimeFor(facts, run.lastRefusal)
      if (!compat) {
        throw new PinnedRelayFallbackError(
          'runtime_unavailable',
          'no compat runtime serves this host'
        )
      }
      return planPinned(options, facts, {
        target: compat.runtimeTarget,
        glibcFloor: compat.glibcFloor
      })
    }
    case 'C': {
      if (host.os === 'win32') {
        throw new PinnedRelayFallbackError(
          'windows_host_unsupported',
          'Windows hosts have no host-Node addon relay'
        )
      }
      const plan = await planHostNodeAddonRelay({
        conn,
        host,
        facts: await ladderTargetFacts(options),
        baseVersion,
        signal
      })
      run.hostNode = plan.hostNode.version
      return plan
    }
    case 'D':
      throw new Error('Rung D has no relay to plan')
  }
}

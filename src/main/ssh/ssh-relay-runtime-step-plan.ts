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
import type { OrcadDeploymentTargetFacts } from './orcad-deployment-target'

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
  if (run.facts) {
    return run.facts
  }
  const facts = await resolvePinnedRelayTargetFacts(options)
  if ('kind' in facts) {
    throw new PinnedRelayFallbackError(
      facts.fallbackReason ?? 'target_unresolved',
      'the host libc answer was not recognised'
    )
  }
  run.facts = facts
  return facts
}

/** Undefined for the host-npm path; throws `PinnedRelayFallbackError` when a rung cannot run. */
export async function planRelayRuntimeStep(
  options: StepPlanOptions
): Promise<PrebuiltRelayPlan | undefined> {
  const { conn, host, baseVersion, step, run, signal } = options
  run.host = host
  switch (step) {
    case 'legacy':
      return undefined
    case 'A': {
      const facts = await ladderTargetFacts(options)
      const plan = await planPinnedNodeRelay({
        conn,
        host,
        baseVersion,
        targetId: run.targetId,
        facts,
        persistedRefusal: (known) => run.persistedPinnedRefusal(known),
        signal
      })
      if (plan.kind === 'host-node') {
        throw new PinnedRelayFallbackError(
          plan.fallbackReason ?? 'artifacts_unavailable',
          'Orca-managed Node cannot run here',
          plan.remembered === true
        )
      }
      return plan
    }
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
      const plan = await planPinnedNodeRelay({
        conn,
        host,
        baseVersion,
        targetId: run.targetId,
        facts,
        compat: { target: compat.runtimeTarget, glibcFloor: compat.glibcFloor },
        signal
      })
      if (plan.kind === 'host-node') {
        throw new PinnedRelayFallbackError(
          plan.fallbackReason ?? 'artifacts_unavailable',
          `compat runtime ${compat.id} cannot run here`,
          plan.remembered === true
        )
      }
      return plan
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

import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { redactRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type {
  OrcadManagedDeployResult,
  OrcadManagedPastLiveTerminals
} from '../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'

import { materializeOrcadArtifact } from '../../orcad/artifact-slots/orcad-artifact-materializer'
import { holdWslForSshUpgrade } from '../../wsl/execution/wsl-ssh-upgrade-hold'
import { wakeAlreadyActiveOrcad } from './orcad-already-active-wake'
import {
  clearManagedOrcadUpdateDeferral,
  recordManagedOrcadUpdateDeferral
} from './orcad-managed-update-deferrals'

import {
  isForceableOrcadDeferral,
  managedOrcadSlot,
  probeManagedOrcadReadiness,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'

import type { requireManagedOrcadEnvironment } from './orcad-managed-runtime-context'

import type { OrcadRemoteContext } from '../install/orcad-remote-context'
import { deployOrcad } from '../install/orcad-remote-deploy'
import type { OrcadDeployOptions } from '../install/orcad-remote-deploy'
import type { OrcadUpdateForce } from '../activation/orcad-update-plan'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from '../activation/orcad-installed-activation'
import {
  pruneManagedOrcadVersions,
  pruneSupersededOrcadCandidates
} from './orcad-managed-version-gc'

import { clearOrcadUpdateFailedThisLaunch } from './orcad-managed-update-failure-memory'
import {
  admitConfirmedIncumbent,
  admitOrcadRecordForIntent,
  managedOrcadUpdateForce
} from './orcad-managed-update-decision'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { updateTerminalCounts } from '../activation/orcad-fenced-stop'
import { refreshMaintainedOrcadPairing } from './orcad-maintenance-pairing-refresh'
import type { LifecycleArgs } from './orcad-managed-lifecycle'
import { withManagedOrcadLifecycle, followLaunchedServerPort } from './orcad-managed-lifecycle'

export async function updateManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs & {
    force?: boolean
    pastLiveTerminals?: OrcadManagedPastLiveTerminals
    endInProcessTerminals?: boolean
  }
): Promise<OrcadManagedDeployResult> {
  const { pastLiveTerminals } = args
  // Update anyway keeps Update's version admission even if a caller also passed force.
  const intent = args.force && !pastLiveTerminals ? 'force' : 'update'
  return await withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    const admitIntent = admitOrcadRecordForIntent(intent, getAppEnvironment().getVersion())
    // Checked under the host fence: another desktop may have activated a build since the confirm.
    const admitRecord: NonNullable<OrcadDeployOptions['admitRecord']> = pastLiveTerminals
      ? admitConfirmedIncumbent(admitIntent, pastLiveTerminals.incumbentVersion)
      : admitIntent
    // A confirmed uncounted census needs full force, which still requires proof no daemon is running.
    const force = managedOrcadUpdateForce(args)
    const result = await runManagedOrcadUpdate(
      userDataPath,
      managed,
      await resolveLinkedOrcadContext(managed.environment, managed.deployment, args.signal),
      { signal: args.signal, force, admitRecord }
    )
    // A completed manual update clears automatic failure suppression; deferred attempts do not.
    if (result.outcome !== 'deferred') {
      clearOrcadUpdateFailedThisLaunch({ kind: 'ssh', id: managed.deployment.sshTargetId })
    }
    return result
  })
}

export async function runManagedOrcadUpdate(
  userDataPath: string,
  { environment, deployment }: Awaited<ReturnType<typeof requireManagedOrcadEnvironment>>,
  context: OrcadRemoteContext,
  args: {
    force?: OrcadUpdateForce
    signal?: AbortSignal
    localOrcadDir?: string
    admitRecord?: OrcadDeployOptions['admitRecord']
  }
): Promise<OrcadManagedDeployResult> {
  const { signal } = args
  // Windows can idle out a loopback WSL distro mid-upload; keep it running for this update.
  const hold = await holdWslForSshUpgrade(context, signal)
  try {
    signal?.throwIfAborted()
    const { countFirst, ...recount } = updateTerminalCounts((options) =>
      collectManagedTerminalCensus(
        userDataPath,
        environment,
        context.activationRecord,
        undefined,
        options
      )
    )
    const census = await countFirst()
    const localOrcadDir =
      args.localOrcadDir ?? (await materializeOrcadArtifact(context.serverTarget, { signal }))
    const slot = managedOrcadSlot(context, deployment.remotePort, signal)
    const result = await deployOrcad({
      ...slot,
      localOrcadDir,
      target: context.serverTarget,
      census,
      ...recount,
      censusRecord: context.activationRecord,
      force: args.force,
      appVersion: getAppEnvironment().getVersion(),
      ...(args.admitRecord ? { admitRecord: args.admitRecord } : {})
    })
    if (result.outcome === 'installed-not-activated') {
      const deferral = {
        outcome: 'deferred' as const,
        candidateVersion: result.fullVersion,
        code: result.code,
        reason: result.reason,
        // Force may override policy deferrals, including a newer host build.
        forceable:
          isForceableOrcadDeferral(result) || result.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
      }
      // Policy refusal is final for this host, not a transient update to retry.
      if (result.code !== ORCAD_ACTIVATION_POLICY_REFUSED_CODE) {
        recordManagedOrcadUpdateDeferral(environment.id, deferral, context.activationRecord)
      }
      await pruneSupersededOrcadCandidates(slot, context.serverTarget, result.fullVersion)
      return deferral
    }
    clearManagedOrcadUpdateDeferral(environment.id)
    const alreadyActive = result.outcome === 'already-active'
    const managed = { environmentId: environment.id, hostLabel: context.target.label }
    const started = alreadyActive && (await wakeAlreadyActiveOrcad(slot, managed))
    const readiness = await probeManagedOrcadReadiness(
      context,
      localOrcadDir,
      result.fullVersion,
      signal
    )
    await pruneManagedOrcadVersions({
      slot,
      serverTarget: context.serverTarget,
      activeVersion: result.fullVersion,
      readiness
    })
    const updated = await refreshMaintainedOrcadPairing(userDataPath, environment.id, readiness)
    if (started || result.outcome !== 'already-active') {
      await followLaunchedServerPort(userDataPath, environment.id)
    }
    return {
      outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
      environment: redactRuntimeEnvironment(updated),
      activeVersion: result.fullVersion
    }
  } finally {
    hold?.release()
  }
}

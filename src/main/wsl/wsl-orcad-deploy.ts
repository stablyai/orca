/** D1/D2b/D8 reuse SSH installation, activation journals/fences and admission over wsl.exe. C5 pairs through the reported loopback port. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { PairingOffer } from '../../shared/pairing'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { ServeReadiness } from '../server/serve-readiness'
import type { WslHostDeferredUpdate } from '../../shared/wsl-host-types'
import { recoverInterruptedOrcadActivation } from '../managed-server/activation/orcad-activation-recovery'
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { materializeOrcadArtifact } from '../orcad/orcad-artifact-materializer'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/orcad-installed-activation'
import { orcadBoundPort } from '../managed-server/lifecycle/orcad-managed-bound-port'
import {
  isForceableOrcadDeferral,
  managedOrcadDeployPolicy,
  managedOrcadSlot
} from '../managed-server/lifecycle/orcad-managed-runtime-context'
import { isWaitingOrcadUpdateDeferral } from '../managed-server/lifecycle/orcad-managed-auto-update'
import { clearOrcadUpdateFailedThisLaunch } from '../managed-server/lifecycle/orcad-managed-update-failure-memory'
import type { OrcadUpdateIntent } from '../managed-server/lifecycle/orcad-managed-update-decision'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { errorMessage } from '../../shared/error-message'
import { pruneWslOrcadVersionsUntilClean } from './wsl-orcad-version-gc-memo'
import { wakeAlreadyActiveOrcad } from '../ssh/orcad-already-active-wake'
import { OrcadActiveReadinessError } from '../ssh/orcad-active-readiness'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import { deployOrcad, type OrcadDeployOptions } from '../ssh/orcad-remote-deploy'
import { isWslMoveUnderwayOnHost } from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { readLocalFullVersion } from '../managed-server/install/remote-versioned-install'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { readWslDistroRegistryIdShared } from './wsl-distro-registry-id'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { createWslOrcadHostTransport, type WslOrcadHostTransport } from './wsl-orcad-host-transport'
import { holdWslDistroWithContext } from './wsl-orcad-held-context'
import { deployWslOrcadWithOneFence } from './wsl-orcad-one-fence-deploy'
import { probeWslActiveOrcad, readWslOrcadPid } from './wsl-orcad-active-probe'
import { wslOrcadConnectStateHints } from './wsl-orcad-connect-state-snapshot'
import { readWslOrcadIncumbent, type WslOrcadIncumbent } from './wsl-orcad-incumbent'
import { adoptUnrecordedWslOrcad } from './wsl-orcad-instance-adoption'
import {
  admitWslOrcadLaunch,
  readRestoredWslOrcadRecord,
  recordWslOrcadUpdateFailure,
  wslOrcadDeferralCode,
  wslOrcadDeferralFailure
} from './wsl-orcad-update-admission'
import { withOwnBuildLaunchEnv } from './wsl-orcad-own-build-launch-env'
import { WSL_NODE_RUNTIME_DOWNLOAD_BUDGET } from './wsl-node-runtime-download-budget'

/** An update this app carries that the host may not take yet; the incumbent keeps serving. */
export type WslOrcadDeferredUpdate = WslHostDeferredUpdate

export type WslOrcadLaunch =
  | {
      outcome: 'ready'
      distro: string
      /** The Lxss registration GUID for the deployment record's `distroId`; null if unreadable. */
      distroId: string | null
      /** The loopback port orcad bound inside the distro (another one when the preferred was taken). */
      port: number
      fullVersion: string
      pid: number | null
      readiness: ServeReadiness
      holder: 'adopted' | 'spawned' | 'unverifiable'
      /** An orcad the record did not name (e.g. left by a failed Remove), now recorded. */
      adoptedInstance?: { version: string; pid: number }
      /** Set when `fullVersion` is the incumbent because the update must wait. */
      deferredUpdate?: WslOrcadDeferredUpdate
    }
  | ({ outcome: 'deferred'; distro: string } & WslOrcadDeferredUpdate)

export type WslOrcadDeployOptions = {
  /** The WSL environment's id; keys host-scoped state (wake dedupe). Defaults per distro. */
  environmentId?: string
  label?: string
  /** Defaults to a connect. */
  intent?: OrcadUpdateIntent
  signal?: AbortSignal
  /** Defaults to one created over `userData`; the app should pass its shared instance. */
  holder?: WslDistroHolder
  createTransport?: (target: WslOrcadHostTarget) => OrcadHostTransport & { dispose?(): void }
  readRegistryId?: (distro: string) => Promise<string | null>
  readIncumbent?: typeof readWslOrcadIncumbent
  /** This desktop's enrolled pairing, which the incumbent's terminal count authenticates with. */
  pairedOffer?: PairingOffer | null
  /** The orcad template to deploy from; defaults to the packaged one (the C10 lane swaps it). */
  templateDir?: string
  /** A no-boot connect's running check (E9), re-read before any further wake. */
  requireRunning?: () => Promise<boolean>
}

/** Until the persisted deployment record (C7) assigns one, the environment is keyed per distro. */
export function defaultWslOrcadEnvironmentId(distro: string): string {
  return `wsl:${wslDistroHolderKey(distro)}`
}

export async function deployAndLaunchWslOrcad(
  distro: string,
  options: WslOrcadDeployOptions = {}
): Promise<WslOrcadLaunch> {
  const name = distro.trim()
  if (!name) {
    throw new Error('A WSL distro name is required')
  }
  const target: WslOrcadHostTarget = {
    kind: 'wsl',
    id: options.environmentId ?? defaultWslOrcadEnvironmentId(name),
    distro: name,
    label: options.label ?? name
  }
  const conn = (options.createTransport ?? defaultTransport)(target)
  try {
    return await launchOverTransport(name, target, conn, options)
  } finally {
    conn.dispose?.()
  }
}

async function launchOverTransport(
  name: string,
  target: WslOrcadHostTarget,
  transport: OrcadHostTransport,
  options: WslOrcadDeployOptions
): Promise<WslOrcadLaunch> {
  const { signal } = options
  let ownBuildVersion: string | null = null
  // Set by the serving probe; readyLaunch reads the pid itself for any other version.
  let probed: { fullVersion: string; pid: number | null } | null = null
  const conn = withOwnBuildLaunchEnv(transport, () => ownBuildVersion)
  // Acquire a holder before launch or WSL can idle-stop orcad's distro.
  const holder = options.holder ?? createWslDistroHolder({ userDataPath: userDataPath() })
  // Read GUID alongside deploy; failure leaves the record without one.
  const distroId = (options.readRegistryId ?? readWslDistroRegistryIdShared)(name).catch(() => null)
  const first = await holdWslDistroWithContext(name, target, conn, holder, signal)
  const { held, connectState } = first
  let context = first.context
  const hints = wslOrcadConnectStateHints(connectState, context.activationRecord)
  const slot = managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT, signal)
  const recovery = await recoverInterruptedOrcadActivation(slot, connectState ?? undefined)
  if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
    throw new Error(recovery.reason)
  }
  if (recovery.outcome === 'recovered') {
    context = { ...context, activationRecord: await readOrcadActivationRecord(slot) }
  }
  // Adopt unrecorded orcad before deploy/wake or its instance lock blocks launch.
  const adoption = await adoptUnrecordedWslOrcad(
    slot,
    context.activationRecord,
    undefined,
    hints.instanceLock(context.activationRecord)
  )
  if (adoption.outcome === 'adopted') {
    context = { ...context, activationRecord: adoption.record }
  }
  const localOrcadDir = await materializeOrcadArtifact(context.serverTarget, {
    signal,
    trustVerificationRecord: true,
    ...(options.templateDir ? { templateDir: options.templateDir } : {})
  })
  const appVersion = getAppEnvironment().getVersion()
  const candidateVersion = readLocalFullVersion(localOrcadDir)
  ownBuildVersion = candidateVersion
  const failureHost = { kind: 'wsl', id: target.id } as const
  const intent = options.intent ?? 'connect'
  const admit = (record: OrcadActivationRecord, admitIntent: OrcadUpdateIntent) =>
    admitWslOrcadLaunch(
      {
        slot,
        record,
        candidateVersion,
        appVersion,
        host: failureHost,
        intent: admitIntent,
        moveRunning: isWslMoveUnderwayOnHost(userDataPath(), name)
      },
      name,
      readyLaunch
    )
  const admitted = await admit(context.activationRecord, intent)
  if ('outcome' in admitted) {
    return admitted
  }
  context = { ...context, activationRecord: admitted }
  const incumbentVersion = context.activationRecord.active
  // Only version changes need incumbent census; same-version connects deploy as no-ops.
  const incumbent: WslOrcadIncumbent | null =
    incumbentVersion && incumbentVersion !== candidateVersion
      ? await (options.readIncumbent ?? readWslOrcadIncumbent)({
          context,
          slot,
          paired: options.pairedOffer ?? null
        })
      : null
  const deployOnce = (extra: Partial<OrcadDeployOptions>) =>
    deployOrcad({
      ...slot,
      conn,
      localOrcadDir,
      target: context.serverTarget,
      ...managedOrcadDeployPolicy(context, appVersion, intent),
      ...(incumbent
        ? {
            census: incumbent.census,
            recountCensus: incumbent.recount,
            releaseIncumbentAdmission: incumbent.releaseAdmission
          }
        : {}),
      force: intent === 'force',
      appVersion,
      recordedNodeRuntimeProbe: true,
      nodeRuntimeDownload: WSL_NODE_RUNTIME_DOWNLOAD_BUDGET,
      ...extra
    }).catch((error: unknown) => {
      if (!signal?.aborted) {
        recordWslOrcadUpdateFailure(failureHost, incumbentVersion, {
          code: 'orcad_update_failed',
          reason: errorMessage(error)
        })
      }
      throw error
    })
  const { deployed, woken } = await deployWslOrcadWithOneFence(
    slot,
    deployOnce,
    hints.deployPreRead(context.activationRecord)
  )
  if (deployed.outcome === 'installed-not-activated') {
    const failure = wslOrcadDeferralFailure(deployed)
    recordWslOrcadUpdateFailure(failureHost, incumbentVersion, failure)
    const restored =
      incumbentVersion && failure ? await readRestoredWslOrcadRecord(slot, incumbentVersion) : null
    if (restored) {
      // After rollback proof, serve the restored incumbent on this connect too.
      const retried = await admit(restored, 'connect')
      if ('outcome' in retried) {
        return retried
      }
    }
    const deferredUpdate: WslOrcadDeferredUpdate = {
      candidateVersion: deployed.fullVersion,
      code: await wslOrcadDeferralCode(slot, deployed, appVersion),
      reason: deployed.reason,
      forceable:
        isForceableOrcadDeferral(deployed.code) ||
        deployed.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
    }
    // Live-terminal deferrals keep the incumbent serving until Update/Force.
    if (
      incumbentVersion &&
      incumbent?.readiness &&
      isWaitingOrcadUpdateDeferral(deployed.code) &&
      // Another client may have activated since census; refuse stale incumbent assumptions.
      (await readOrcadActivationRecord(slot)).active === incumbentVersion
    ) {
      const serving = {
        fullVersion: incumbentVersion,
        readiness: incumbent.readiness
      }
      return { ...(await readyLaunch(serving)), deferredUpdate }
    }
    return { outcome: 'deferred', distro: name, ...deferredUpdate }
  }
  clearOrcadUpdateFailedThisLaunch(failureHost)
  const probe = async () => {
    const answer = await probeWslActiveOrcad(context, localOrcadDir, deployed.fullVersion, signal)
    probed = { fullVersion: deployed.fullVersion, pid: answer.pid }
    return answer.readiness
  }
  let readiness: ServeReadiness
  if (deployed.outcome === 'already-active') {
    // A stopped distro ended the active slot with it; the one-fence deploy already woke it.
    await (woken ? null : wakeAlreadyActiveOrcad(slot))
    // Why once more: on a distro still booting, the orcad the wake saw serving can exit before
    // the probe; that is a stopped slot to start, not a failed connect.
    readiness = await probe().catch(async (error: unknown) => {
      if (!(error instanceof OrcadActiveReadinessError) || error.verdict !== 'exited') {
        throw error
      }
      // A `wsl --shutdown` during a no-boot connect must not be undone by this second wake.
      if (options.requireRunning && !(await options.requireRunning())) {
        throw new WslDistroNotRunningError(name)
      }
      await wakeAlreadyActiveOrcad(slot)
      return probe()
    })
  } else {
    readiness = await probe()
  }
  await pruneWslOrcadVersionsUntilClean(target.id, {
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployed.fullVersion,
    readiness
  })
  return readyLaunch({ fullVersion: deployed.fullVersion, readiness })

  async function readyLaunch(serving: {
    fullVersion: string
    readiness: ServeReadiness
  }): Promise<Extract<WslOrcadLaunch, { outcome: 'ready' }>> {
    // The serving probe already read it; an admission that serves an incumbent did not.
    const pid =
      probed?.fullVersion === serving.fullVersion
        ? probed.pid
        : await readWslOrcadPid(context, serving.fullVersion, signal)
    return {
      outcome: 'ready',
      distro: name,
      distroId: await distroId,
      port: orcadBoundPort(serving.readiness) ?? ORCAD_MANAGED_REMOTE_PORT,
      fullVersion: serving.fullVersion,
      pid,
      readiness: serving.readiness,
      holder: held.outcome,
      ...(adoption.outcome === 'adopted'
        ? { adoptedInstance: { version: adoption.version, pid: adoption.pid } }
        : {})
    }
  }
}

function defaultTransport(target: WslOrcadHostTarget): WslOrcadHostTransport {
  return createWslOrcadHostTransport({ target })
}

function userDataPath(): string {
  return getAppEnvironment().getPath('userData')
}

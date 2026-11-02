/**
 * Deploys and starts orcad inside one WSL distro (design D1, D2b, D8), reusing the SSH host's
 * install, activation fence/journal and version admission over the `wsl.exe` transport.
 * No pairing here: the stdio bridge (C5) connects to the loopback port this reports.
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { ServeReadiness } from '../server/serve-readiness'
import type { WslHostDeferredUpdate } from '../../shared/wsl-host-types'
import { recoverInterruptedOrcadActivation } from '../managed-server/activation/orcad-activation-recovery'
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { materializeOrcadArtifact } from '../orcad/orcad-artifact-materializer'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/orcad-installed-activation'
import { orcadBoundPort } from '../managed-server/lifecycle/orcad-managed-bound-port'
import {
  isForceableOrcadDeferral,
  managedOrcadDeployPolicy,
  managedOrcadInstallDir,
  managedOrcadSlot,
  probeManagedOrcadReadiness
} from '../managed-server/lifecycle/orcad-managed-runtime-context'
import { isWaitingOrcadUpdateDeferral } from '../managed-server/lifecycle/orcad-managed-auto-update'
import { pruneManagedOrcadVersions } from '../managed-server/lifecycle/orcad-managed-version-gc'
import { wakeAlreadyActiveOrcad } from '../ssh/orcad-already-active-wake'
import { resolveOrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import { deployOrcad } from '../ssh/orcad-remote-deploy'
import { ORCAD_PID_FILENAME } from '../managed-server/install/orcad-remote-host-support'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { readLocalFullVersion } from '../managed-server/install/remote-versioned-install'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { readWslDistroRegistryIdShared } from './wsl-distro-registry-id'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { createWslOrcadHostTransport, type WslOrcadHostTransport } from './wsl-orcad-host-transport'
import { readWslOrcadIncumbent, type WslOrcadIncumbent } from './wsl-orcad-incumbent'
import { adoptUnrecordedWslOrcad } from './wsl-orcad-instance-adoption'

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
  force?: boolean
  signal?: AbortSignal
  /** Defaults to one created over `userData`; the app should pass its shared instance. */
  holder?: WslDistroHolder
  createTransport?: (target: WslOrcadHostTarget) => OrcadHostTransport & { dispose?(): void }
  readRegistryId?: (distro: string) => Promise<string | null>
  readIncumbent?: typeof readWslOrcadIncumbent
  /** The orcad template to deploy from; defaults to the packaged one (the C10 lane swaps it). */
  templateDir?: string
}

/** Until the persisted deployment record (C7) assigns one, the environment is keyed per distro. */
export function defaultWslOrcadEnvironmentId(distro: string): string {
  return `wsl:${wslDistroHolderKey(distro)}`
}

/** WSL 1 runs no Linux kernel, so the pinned Node and its pty cannot run there. */
export function isWsl1KernelRelease(release: string): boolean {
  return /^\d+\.\d+\.\d+-\d+-Microsoft$/.test(release.trim())
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
  conn: OrcadHostTransport,
  options: WslOrcadDeployOptions
): Promise<WslOrcadLaunch> {
  const { signal } = options
  const kernel = await execCommand(conn, 'uname -r', { signal })
  if (isWsl1KernelRelease(kernel)) {
    throw new OrcadHostUnsupportedError(
      `The WSL 1 distro ${name} is not supported by managed orcad. ` +
        `Convert it with: wsl --set-version ${name} 2`
    )
  }
  // Before the launch: without a holder WSL stops an idle distro and orcad with it.
  const holder = options.holder ?? createWslDistroHolder({ userDataPath: userDataPath() })
  const held = await holder.ensureHeld(name)
  // Read alongside the deploy; a failed read only leaves the record without a GUID.
  const distroId = (options.readRegistryId ?? readWslDistroRegistryIdShared)(name).catch(() => null)
  let context = await resolveOrcadRemoteContext(target, conn, signal)
  const slot = managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT, signal)
  const recovery = await recoverInterruptedOrcadActivation(slot)
  if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
    throw new Error(recovery.reason)
  }
  if (recovery.outcome === 'recovered') {
    context = { ...context, activationRecord: await readOrcadActivationRecord(slot) }
  }
  // Before deploy or wake: an orcad the record does not name would keep the instance lock.
  const adoption = await adoptUnrecordedWslOrcad(slot, context.activationRecord)
  if (adoption.outcome === 'adopted') {
    context = { ...context, activationRecord: adoption.record }
  }
  const localOrcadDir = await materializeOrcadArtifact(context.serverTarget, {
    signal,
    trustVerificationRecord: true,
    ...(options.templateDir ? { templateDir: options.templateDir } : {})
  })
  const appVersion = getAppEnvironment().getVersion()
  const incumbentVersion = context.activationRecord.active
  // Only an update asks the incumbent: the same version is a no-op deploy on every connect.
  const incumbent: WslOrcadIncumbent | null =
    incumbentVersion && incumbentVersion !== readLocalFullVersion(localOrcadDir)
      ? await (options.readIncumbent ?? readWslOrcadIncumbent)({
          context,
          slot
        })
      : null
  const deployed = await deployOrcad({
    ...slot,
    conn,
    localOrcadDir,
    target: context.serverTarget,
    ...managedOrcadDeployPolicy(context, appVersion, options.force),
    ...(incumbent ? { census: incumbent.census } : {}),
    ...(incumbent?.recount ? { recountCensus: incumbent.recount } : {}),
    force: options.force,
    appVersion,
    recordedNodeRuntimeProbe: true
  })
  if (deployed.outcome === 'installed-not-activated') {
    const deferredUpdate: WslOrcadDeferredUpdate = {
      candidateVersion: deployed.fullVersion,
      code: deployed.code,
      reason: deployed.reason,
      forceable:
        isForceableOrcadDeferral(deployed.code) ||
        deployed.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
    }
    // Waiting (e.g. live terminals) is not broken: the incumbent serves until Update or Force.
    if (
      incumbentVersion &&
      incumbent?.readiness &&
      isWaitingOrcadUpdateDeferral(deployed.code) &&
      // Another client may have activated a build since the census; then this one is stale.
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
  if (deployed.outcome === 'already-active') {
    // A stopped distro ended the active slot with it.
    await wakeAlreadyActiveOrcad(slot)
  }
  const readiness = await probeManagedOrcadReadiness(
    context,
    localOrcadDir,
    deployed.fullVersion,
    signal
  )
  await pruneManagedOrcadVersions({
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
    const pidFile = joinRemotePath(
      context.host,
      managedOrcadInstallDir(context, serving.fullVersion),
      ORCAD_PID_FILENAME
    )
    const pid = Number.parseInt(
      await execCommand(conn, `cat ${shellEscape(pidFile)} 2>/dev/null || true`, { signal }),
      10
    )
    return {
      outcome: 'ready',
      distro: name,
      distroId: await distroId,
      port: orcadBoundPort(serving.readiness) ?? ORCAD_MANAGED_REMOTE_PORT,
      fullVersion: serving.fullVersion,
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
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

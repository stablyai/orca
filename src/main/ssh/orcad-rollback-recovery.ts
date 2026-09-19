import type { OrcadRollbackOptions } from './orcad-remote-rollback'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { ORCAD_STATE_SNAPSHOT_DIR } from './orcad-activation-record'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  newestStateMtimeCommand,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { joinRemotePath } from './ssh-remote-platform'
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { resolveOrcadSlotNodeFallback } from './orcad-slot-runtime-eligibility'
import {
  exec,
  launchAndGate,
  stopOrcadSlot,
  withoutAbortSignal
} from './orcad-remote-runtime-control'

export type ActiveRuntimeIdentity = {
  version: string
  remoteDir: string
  buildHash: string
  nodePath?: string
}

export type RollbackRescueSnapshot =
  | { state: 'captured'; dir: string }
  | { state: 'empty'; dir: null }

export function snapshotDirPath(options: OrcadRollbackOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    ORCAD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

export async function readStateWritesSinceActivation(
  options: OrcadRollbackOptions
): Promise<boolean | null> {
  if (!options.record.activatedAt) {
    return null
  }
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt) / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  let output: string
  try {
    output = await exec(options, newestStateMtimeCommand(options.host, options.userDataDir))
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return null
  }
  const newest = parseNewestStateMtimeSeconds(output)
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function resolveActiveRuntimeIdentity(
  options: OrcadRollbackOptions
): Promise<ActiveRuntimeIdentity | null> {
  if (!options.record.active) {
    return null
  }
  const remoteDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    options.record.active,
    options.host.pathFlavor
  )
  const [buildHash, nodePath] = await Promise.all([
    readRemoteOrcadBuildHash({
      conn: options.conn,
      host: options.host,
      remoteInstallDir: remoteDir,
      signal: options.signal
    }),
    resolveOrcadSlotNodeFallback(options.conn, options.host, remoteDir, options.signal)
  ])
  return {
    version: options.record.active,
    remoteDir,
    buildHash,
    ...(nodePath ? { nodePath } : {})
  }
}

export async function captureRollbackRescue(
  options: OrcadRollbackOptions,
  dirName: string
): Promise<RollbackRescueSnapshot | null> {
  const dir = snapshotDirPath(options, dirName)
  const captured = parseOrcadSnapshotCapture(
    await exec(options, captureOrcadStateSnapshotCommand(options.host, options.userDataDir, dir))
  )
  if (captured === 'failed') {
    return null
  }
  return captured === 'captured' ? { state: 'captured', dir } : { state: 'empty', dir: null }
}

async function restoreRollbackRescue(
  options: OrcadRollbackOptions,
  rescue: RollbackRescueSnapshot
): Promise<boolean> {
  const output = await exec(
    options,
    rescue.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(options.host, options.userDataDir, rescue.dir)
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  )
  return parseOrcadSnapshotRestore(output) === 'restored'
}

export async function recoverActiveRuntime(
  options: OrcadRollbackOptions,
  identity: ActiveRuntimeIdentity,
  rescue?: RollbackRescueSnapshot
): Promise<{ recovered: boolean; reason: string }> {
  const recoveryOptions = withoutAbortSignal(options)
  try {
    if (rescue && !(await restoreRollbackRescue(recoveryOptions, rescue))) {
      return {
        recovered: false,
        reason: 'the rescue snapshot could not be restored'
      }
    }
    const recovery = await launchAndGate(recoveryOptions, identity)
    if (recovery.verdict.decision === 'reject') {
      return {
        recovered: false,
        reason: `the active runtime failed its recovery health gate: ${recovery.verdict.reason}`
      }
    }
    return {
      recovered: true,
      reason: `orcad ${identity.version} was restored and is serving again`
    }
  } catch (error) {
    return {
      recovered: false,
      reason: `active-runtime recovery failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export async function stopFailedTargetAndRecoverActive(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl,
  target: ActiveRuntimeIdentity,
  active: ActiveRuntimeIdentity,
  rescue: RollbackRescueSnapshot
): Promise<{ code?: string; reason: string }> {
  let stoppedTarget: Awaited<ReturnType<typeof stopOrcadSlot>>
  try {
    stoppedTarget = await stopOrcadSlot(withoutAbortSignal(options), target.remoteDir)
  } catch (error) {
    lock.retain()
    return {
      code: 'orcad_rollback_target_stop_unverifiable',
      reason:
        `The rollback target could not be confirmed stopped: ` +
        `${error instanceof Error ? error.message : String(error)} The rescue snapshot is ` +
        'intact, but restoring it while the target may still own the data root would be unsafe.'
    }
  }
  if (!orcadStopFreedTheHost(stoppedTarget)) {
    lock.retain()
    return {
      code: 'orcad_rollback_target_stop_incomplete',
      reason:
        `The rollback target could not be confirmed stopped (${stoppedTarget}). The rescue ` +
        'snapshot is intact, but restoring it while the target may still own the data root ' +
        'would be unsafe.'
    }
  }
  const recovery = await recoverActiveRuntime(options, active, rescue)
  if (!recovery.recovered) {
    lock.retain()
  }
  return { reason: recovery.reason }
}

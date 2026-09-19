import type { OrcadDeployOptions, OrcadDeployResult } from './orcad-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  ORCAD_STATE_SNAPSHOT_DIR,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from './orcad-activation-record'
import { evaluateOrcadActivation } from './orcad-activation-gate'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { joinRemotePath } from './ssh-remote-platform'
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import {
  exec,
  launchAndAwaitReadiness,
  stopOrcadSlot,
  withoutAbortSignal
} from './orcad-remote-runtime-control'

export type PreActivationSnapshot =
  | { state: 'captured'; record: OrcadStateSnapshot }
  | { state: 'empty'; record: null }

export type IncumbentIdentity = {
  version: string
  remoteDir: string
  buildHash: string
  runtimeKind: 'bun' | 'node'
}

function baseDir(options: OrcadDeployOptions): string {
  return joinRemotePath(options.host, options.remoteHome, RELAY_REMOTE_DIR)
}

export async function captureSnapshot(
  options: OrcadDeployOptions,
  fullVersion: string,
  outgoingVersion: string | null,
  takenAt: Date,
  dirName: string
): Promise<PreActivationSnapshot> {
  const snapshotDir = joinRemotePath(
    options.host,
    baseDir(options),
    ORCAD_STATE_SNAPSHOT_DIR,
    dirName
  )
  const capture = parseOrcadSnapshotCapture(
    await exec(
      options,
      captureOrcadStateSnapshotCommand(options.host, options.userDataDir, snapshotDir)
    )
  )
  if (capture === 'failed') {
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}. Orca's ` +
        'persisted state carries no schema version, so without a snapshot a rollback has no ' +
        'way back. Refusing to activate.'
    )
  }
  if (capture === 'empty') {
    return { state: 'empty', record: null }
  }
  return {
    state: 'captured',
    record: {
      dirName,
      takenBeforeVersion: fullVersion,
      readableByVersion: outgoingVersion,
      takenAt: takenAt.toISOString()
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function recoverIncumbentAfterSnapshotFailure(
  options: OrcadDeployOptions,
  lock: OrcadActivationLockControl,
  incumbent: IncumbentIdentity,
  candidateVersion: string,
  snapshotError: unknown
): Promise<OrcadDeployResult> {
  let parsed: Awaited<ReturnType<typeof launchAndAwaitReadiness>>
  try {
    parsed = await launchAndAwaitReadiness(withoutAbortSignal(options), {
      remoteInstallDir: incumbent.remoteDir,
      nodePath: options.nodePath,
      fullVersion: incumbent.version,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      allowHostNodeFallback: true
    })
  } catch (restartError) {
    if (isUnconfirmedSshCommandTermination(restartError)) {
      throw restartError
    }
    lock.retain()
    return {
      outcome: 'installed-not-activated',
      fullVersion: candidateVersion,
      code: 'orcad_incumbent_restart_failed',
      reason:
        `The candidate was not launched because the post-stop state snapshot failed: ` +
        `${errorMessage(snapshotError)} Restarting orcad ${incumbent.version} also failed: ` +
        `${errorMessage(restartError)} This host is not serving orcad and requires recovery.`
    }
  }
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: incumbent.buildHash,
    fullVersion: incumbent.version,
    runtimeKind: incumbent.runtimeKind,
    port: options.port
  })
  if (verdict.decision === 'reject') {
    lock.retain()
    return {
      outcome: 'installed-not-activated',
      fullVersion: candidateVersion,
      code: 'orcad_incumbent_restart_failed',
      reason:
        `The candidate was not launched because the post-stop state snapshot failed: ` +
        `${errorMessage(snapshotError)} orcad ${incumbent.version} was relaunched but failed ` +
        `its recovery health gate: ${verdict.reason} This host is not serving a verified ` +
        'orcad and requires recovery.'
    }
  }
  return {
    outcome: 'installed-not-activated',
    fullVersion: candidateVersion,
    code: 'orcad_pre_activation_snapshot_failed',
    reason:
      `The candidate was not launched because the post-stop state snapshot failed: ` +
      `${errorMessage(snapshotError)} orcad ${incumbent.version} was restarted and is serving again.`
  }
}

/** Stop the rejected candidate before restoring state and restarting the incumbent. */
export async function restoreIncumbent(
  options: OrcadDeployOptions,
  record: OrcadActivationRecord,
  incumbent: IncumbentIdentity | null,
  candidateDir: string,
  snapshot: PreActivationSnapshot | null
): Promise<{ message: string; code?: string; recovered: boolean }> {
  const stopped = await stopOrcadSlot(options, candidateDir)
  if (!orcadStopFreedTheHost(stopped)) {
    return {
      code: 'orcad_rejected_candidate_stop_incomplete',
      message: `The candidate itself did not stop (${stopped}); the host may still be serving the rejected build.`,
      recovered: false
    }
  }
  if (!snapshot) {
    return {
      code: 'orcad_incumbent_snapshot_missing',
      message:
        'The rejected candidate stopped, but no pre-activation state verdict exists. The previous version was not restarted against potentially migrated state.',
      recovered: false
    }
  }
  const snapshotDir =
    snapshot.state === 'captured'
      ? joinRemotePath(
          options.host,
          baseDir(options),
          ORCAD_STATE_SNAPSHOT_DIR,
          snapshot.record.dirName
        )
      : null
  let restoreOutput: string
  try {
    restoreOutput = await exec(
      options,
      snapshotDir
        ? restoreOrcadStateSnapshotCommand(options.host, options.userDataDir, snapshotDir)
        : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
    )
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    restoreOutput = 'FAILED'
  }
  const restored = parseOrcadSnapshotRestore(restoreOutput)
  if (restored !== 'restored') {
    return {
      code: 'orcad_incumbent_state_restore_failed',
      message:
        `The rejected candidate stopped, but its pre-activation state could not be restored (${restored}). ` +
        'The previous version was not restarted against potentially migrated state.',
      recovered: false
    }
  }
  if (!record.active || !incumbent) {
    return {
      message:
        'No previous version was active; pre-activation state was restored and this host is now serving nothing.',
      recovered: true
    }
  }
  const parsed = await launchAndAwaitReadiness(options, {
    remoteInstallDir: incumbent.remoteDir,
    nodePath: options.nodePath,
    fullVersion: record.active,
    userDataDir: options.userDataDir,
    bindHost: options.bindHost,
    port: options.port,
    allowHostNodeFallback: true
  })
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: incumbent.buildHash,
    fullVersion: incumbent.version,
    runtimeKind: incumbent.runtimeKind,
    port: options.port
  })
  return verdict.decision === 'activate'
    ? { message: `orcad ${record.active} was restarted and is serving again.`, recovered: true }
    : {
        code: 'orcad_incumbent_restart_failed',
        message:
          `orcad ${record.active} was relaunched but failed its recovery health gate: ` +
          `${verdict.reason} This host is not serving a verified orcad.`,
        recovered: false
      }
}

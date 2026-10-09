/**
 * Slot-level verdicts shared by activation, rollback and their crash recovery.
 *
 * Every verdict here is the execution host's: `exited` only on positive proof, and a probe
 * that could not answer is `unverifiable` — never a reason to start a second slot.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadActivationExpectation } from './orcad-activation-gate'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import {
  launchOrcadSlotAndAwaitReadiness,
  OrcadActiveReadinessError,
  probeActiveOrcadReadiness
} from './orcad-active-readiness'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import {
  parseOrcadStopOutcome,
  stopOrcadCommand,
  type OrcadStopOutcome
} from './orcad-remote-process-control'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { orcadActivationTransactionRoot } from './orcad-activation-transaction'
import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'

export const ORCAD_SLOT_STOP_WAIT_SECONDS = 20

export type OrcadSlotOptions = OrcadRemoteExecTarget & {
  remoteHome: string
  /** Host Node for legacy slots only; a slot's own runtime marker wins. */
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  readinessTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type OrcadSlotIdentity = { version: string; remoteDir: string; buildHash: string }

function expectation(identity: OrcadSlotIdentity): OrcadActivationExpectation {
  return { buildHash: identity.buildHash, fullVersion: identity.version }
}

export function orcadSlotDir(options: OrcadSlotOptions, version: string): string {
  return computeRemoteInstallDir(ORCAD_INSTALL_MODEL, options.remoteHome, version)
}

/** Reads the installed bytes' hash, so a later readiness payload can be matched to them. */
export async function resolveOrcadSlotIdentity(
  options: OrcadSlotOptions,
  version: string
): Promise<OrcadSlotIdentity> {
  const remoteDir = orcadSlotDir(options, version)
  return { version, remoteDir, buildHash: await readRemoteOrcadBuildHash(options, remoteDir) }
}

export function launchOrcadSlot(
  options: OrcadSlotOptions,
  identity: OrcadSlotIdentity
): Promise<ServeReadiness> {
  return launchOrcadSlotAndAwaitReadiness(
    options,
    {
      remoteInstallDir: identity.remoteDir,
      nodePath: options.nodePath,
      fullVersion: identity.version,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      // Every SSH launch is client-managed, so every one may idle out and be woken on connect.
      activationRoot: orcadActivationTransactionRoot(options.host, options.remoteHome)
    },
    expectation(identity)
  )
}

/** Proves the slot serves, starting it only on proven exit. */
export async function ensureOrcadSlotServing(
  options: OrcadSlotOptions,
  identity: OrcadSlotIdentity
): Promise<ServeReadiness> {
  const liveness = parseOrcadLiveness(
    await execOrcadRemote(options, orcadLivenessProbeCommand(options.host, identity.remoteDir))
  )
  if (liveness === 'LIVE') {
    return probeActiveOrcadReadiness(
      { ...options, remoteInstallDir: identity.remoteDir },
      expectation(identity)
    )
  }
  if (liveness === 'UNKNOWN') {
    throw new OrcadActiveReadinessError(
      'unverifiable',
      `orcad ${identity.version} process state is unverifiable.`
    )
  }
  return launchOrcadSlot(options, identity)
}

/** `justLaunched` only for a slot this run started; otherwise the readiness PID must agree. */
export async function stopOrcadSlot(
  options: OrcadSlotOptions,
  remoteDir: string,
  justLaunched: boolean
): Promise<OrcadStopOutcome> {
  return parseOrcadStopOutcome(
    await execOrcadRemote(
      options,
      stopOrcadCommand(
        options.host,
        remoteDir,
        justLaunched
          ? { waitSeconds: ORCAD_SLOT_STOP_WAIT_SECONDS, justLaunched: true }
          : { waitSeconds: ORCAD_SLOT_STOP_WAIT_SECONDS, nodePath: options.nodePath }
      )
    )
  )
}

export type OrcadSlotQuiescence = 'exited' | 'other-slot-serving'

/**
 * Before an interrupted run's state is replaced: the slot it started must be proven exited and
 * the slot being restored must not be running, or must already be serving (nothing to undo).
 *
 * A missing PID file is not proof of exit: an SSH drop can kill the launcher after `nohup`
 * but before it records `$!`, so the data root's owner records decide.
 */
export async function quiesceInterruptedOrcadSlot(
  options: OrcadSlotOptions,
  /** `null` when nothing was launched, so only `otherSlot` needs ruling out. */
  version: string | null,
  otherSlot: OrcadSlotIdentity | null
): Promise<OrcadSlotQuiescence> {
  const remoteDir = version === null ? null : orcadSlotDir(options, version)
  const stopped =
    remoteDir === null ? 'already-exited' : await stopOrcadSlot(options, remoteDir, false)
  let exited = stopped === 'stopped' || stopped === 'already-exited'
  if ((stopped === 'unknown' || stopped === 'unconfirmed') && remoteDir !== null) {
    // No verified answer, e.g. the slot died before readiness; liveness decides.
    exited = (await slotLiveness(options, remoteDir)) === 'DEAD'
  }
  if (otherSlot) {
    const other = await slotLiveness(options, otherSlot.remoteDir)
    if (other === 'LIVE' && (exited || stopped === 'no-pid')) {
      // The serving slot holds the instance lock, so a PID-less launch cannot own the state.
      await probeActiveOrcadReadiness(
        { ...options, remoteInstallDir: otherSlot.remoteDir },
        expectation(otherSlot)
      )
      return 'other-slot-serving'
    }
    if (other !== 'DEAD') {
      throw new OrcadActiveReadinessError(
        'unverifiable',
        `orcad ${version ?? 'candidate'} (${stopped}) and ${otherSlot.version} (${other}) cannot both be ` +
          'ruled out as owners of the shared state; it was not replaced.'
      )
    }
  }
  if (!exited && stopped === 'no-pid' && remoteDir !== null) {
    const admission = parseInitialOrcadActivationAdmission(
      await execOrcadRemote(
        options,
        initialOrcadActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    exited = admission.decision === 'proceed'
  }
  if (!exited) {
    throw new OrcadActiveReadinessError(
      'unverifiable',
      `orcad ${version ?? 'candidate'} could not be confirmed stopped (${stopped}); replacing its state would be unsafe.`
    )
  }
  return 'exited'
}

export async function slotLiveness(
  options: OrcadSlotOptions,
  remoteDir: string
): Promise<'LIVE' | 'DEAD' | 'UNKNOWN'> {
  return parseOrcadLiveness(
    await execOrcadRemote(options, orcadLivenessProbeCommand(options.host, remoteDir))
  )
}

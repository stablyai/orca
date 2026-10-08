import { evaluateOrcadActivation, type OrcadActivationVerdict } from './orcad-activation-gate'
import { orcadActivationTransactionRoot } from './orcad-activation-lock'
import type { OrcadReadinessParse } from './orcad-remote-launch'
import {
  launchOrcadAndAwaitReadiness,
  type OrcadRemoteExecTarget
} from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'

type CandidateLaunchTarget = Parameters<typeof launchOrcadAndAwaitReadiness>[0] &
  OrcadRemoteExecTarget & {
    remoteHome: string
    nodePath: string
    userDataDir: string
    bindHost: string
    port: number
  }

/**
 * Starts one slot and judges its readiness. An unconfirmed SSH termination rethrows: it says
 * nothing about the candidate, so it must never read as a rejected one.
 */
export async function launchAndJudgeOrcadSlot(
  options: CandidateLaunchTarget,
  slot: { remoteInstallDir: string; fullVersion: string; buildHash: string }
): Promise<{ verdict: OrcadActivationVerdict; launchError: unknown }> {
  let parsed: OrcadReadinessParse | null = null
  let launchError: unknown
  try {
    parsed = await launchOrcadAndAwaitReadiness(options, {
      remoteInstallDir: slot.remoteInstallDir,
      nodePath: options.nodePath,
      fullVersion: slot.fullVersion,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      activationRoot: orcadActivationTransactionRoot(options.host, options.remoteHome)
    })
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    launchError = error
  }
  const verdict = evaluateOrcadActivation(parsed?.state === 'ready' ? parsed.readiness : null, {
    buildHash: slot.buildHash,
    fullVersion: slot.fullVersion
  })
  return { verdict, launchError }
}

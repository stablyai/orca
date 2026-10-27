import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import type { WslGuestIdentity } from './wsl-guest-process-identity'
import type { Trigger } from './wsl-orcad-liveness-state'
import { nextWslLivenessProbe, type WslLivenessEvidence } from './wsl-orcad-liveness-verdict'
import type { WslOrcadWatch } from './wsl-orcad-watch'

/** How long a failed exit waits before trusting a list that still shows its distro running. */
export const EXIT_SETTLE_MS = 500

export function failedExit(trigger: Trigger): boolean {
  return trigger !== 'heartbeat' && trigger.source !== 'verify' && trigger.code !== 0
}

export function confirmsRunning(running: WslRunningDistrosRead, key: string): boolean {
  return (
    running.status === 'confirmed' &&
    running.distros.some((candidate) => wslDistroHolderKey(candidate) === key)
  )
}

/** Asks only what the classifier still needs, in order: identity, then orcad's port. */
export async function gatherWslLivenessEvidence(
  evidence: WslLivenessEvidence,
  probes: {
    readIdentity: () => Promise<WslGuestIdentity | null>
    probePort: () => Promise<WslOrcadWatch['signal']>
  }
): Promise<WslLivenessEvidence> {
  for (let probe = nextWslLivenessProbe(evidence); probe; probe = nextWslLivenessProbe(evidence)) {
    if (probe === 'identity') {
      evidence.identity = await probes.readIdentity()
    } else {
      evidence.orcadPort = await probes.probePort()
    }
  }
  return evidence
}

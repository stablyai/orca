// SSH channel closure does not prove host mutation exit; only command output or exit may release the activation fence.
import { ORCAD_STATE_MUTATION_DEADLINE_SECONDS } from './orcad-state-snapshot'
import {
  ORCAD_STATE_MUTATION_BUSY,
  ORCAD_STATE_MUTATION_DEADLINE
} from './orcad-state-snapshot-members'
import type { OrcadRemoteExecTarget } from '../install/orcad-remote-runtime-control'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { isOrcadFenceLost, OrcadFenceLostError } from '../activation/orcad-activation-fence-scope'

// Let the host deadline kill workload before client observation times out.
export const ORCAD_STATE_MUTATION_CLIENT_TIMEOUT_MS =
  (ORCAD_STATE_MUTATION_DEADLINE_SECONDS + 60) * 1000

function unconfirmed(error: Error): Error & { sshChannelCloseConfirmed: false } {
  return Object.assign(error, { sshChannelCloseConfirmed: false as const })
}

/** Do not abort observation: caller cancellation cannot stop host-side mutation. */
export async function execOrcadStateMutation(
  target: OrcadRemoteExecTarget,
  command: string
): Promise<string> {
  let output: string
  try {
    output = await execCommand(target.conn, command, {
      wrapCommand: target.host.commandDialect !== 'powershell',
      timeoutMs: ORCAD_STATE_MUTATION_CLIENT_TIMEOUT_MS
    })
  } catch (error) {
    // Channel termination flags uncertainty; exit-status errors prove completion.
    if (error instanceof Error && 'sshChannelCloseConfirmed' in error) {
      throw unconfirmed(error)
    }
    throw isOrcadFenceLost(error) ? new OrcadFenceLostError() : error
  }
  const verdict = output.trim().split('\n').pop()?.trim()
  if (verdict === ORCAD_STATE_MUTATION_BUSY) {
    throw unconfirmed(
      new Error('Another snapshot capture or restore is still running on the host.')
    )
  }
  if (verdict === ORCAD_STATE_MUTATION_DEADLINE) {
    throw unconfirmed(
      new Error(
        `A snapshot capture or restore ran past ${ORCAD_STATE_MUTATION_DEADLINE_SECONDS}s and ` +
          'the host stopped it part way through.'
      )
    )
  }
  return output
}

/** Fall back only for finished failures; unconfirmed mutation remains fenced. */
export function execOrcadStateMutationOr(
  target: OrcadRemoteExecTarget,
  command: string,
  fallback = ''
): Promise<string> {
  return execOrcadStateMutation(target, command).catch((error: unknown) => {
    // Lost ownership is a refusal, never a capture failure eligible for fallback.
    if (isUnconfirmedSshCommandTermination(error) || error instanceof OrcadFenceLostError) {
      throw error
    }
    return fallback
  })
}

import { parseOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { OrchestrationError } from '../orchestration-error'

export function workerDockSession(party: string): string {
  const session = parseOrcaSessionAddress(party)
  if (!session) {
    throw new OrchestrationError('invalid_argument', 'A worker dock needs a source session.')
  }
  return session
}

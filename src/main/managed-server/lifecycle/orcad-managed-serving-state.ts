import type { SshTarget } from '../../../shared/ssh-types'

export type OrcadManagedServing =
  | { state: 'serving' }
  /** Forwards must follow the restarted server's bound port. */
  | { state: 'started'; boundPort: number | null }
  | { state: 'unverifiable'; detail: string }

export const MANAGED_ORCAD_FENCED_DETAIL =
  'An update, rollback or recovery holds this host; it was not started.'

export const MANAGED_ORCAD_NOT_ACTIVATED_DETAIL = 'This host has no activated Orca server to start.'

export type ManagedOrcadStartListener = {
  starting: (target: SshTarget) => void
  /** Unverifiable results include the reason and log tail. */
  settled: (target: SshTarget, environmentId: string, serving: OrcadManagedServing) => void
}

let startListener: ManagedOrcadStartListener | null = null

export function setManagedOrcadStartListener(listener: ManagedOrcadStartListener | null): void {
  startListener = listener
}

export function getManagedOrcadStartListener(): ManagedOrcadStartListener | null {
  return startListener
}

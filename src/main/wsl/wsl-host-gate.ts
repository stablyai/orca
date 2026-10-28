import {
  formatWslHostsServeOnlyArgument,
  isWslHostsInternalGateOpen,
  noteWslHostsServeOnly,
  resolveWslHostsGateState,
  type WslHostsGateState
} from '../../shared/wsl-host-internal-gate'
import type { OrcadDeploymentLink } from '../../shared/runtime-environments'

export const WSL_HOSTS_GATED_OFF_MESSAGE = 'WSL hosts are not available in this build.'
export const WSL_HOSTS_NEW_WORK_PAUSED_MESSAGE =
  'Adding WSL hosts and moving projects onto them is paused in this build. Your saved WSL hosts keep working.'

// Fixed for the run once main reads the disk; nothing can create a host or a move while not open.
let promoted: { hasSavedWslHost: boolean; hasWslMoveCutover: boolean } | null = null

/** Startup, before any gate check: a closed gate with saved WSL work becomes `serve-only`. */
export function configureWslHostsGate(facts: {
  hasSavedWslHost: () => boolean
  hasWslMoveCutover: () => boolean
}): void {
  if (wslHostsGateOpen()) {
    promoted = null
    noteWslHostsServeOnly(false)
    return
  }
  // Unreadable state counts as absent: today's closed behavior.
  const read = (fact: () => boolean): boolean => {
    try {
      return fact()
    } catch {
      return false
    }
  }
  promoted = {
    hasSavedWslHost: read(facts.hasSavedWslHost),
    hasWslMoveCutover: read(facts.hasWslMoveCutover)
  }
  noteWslHostsServeOnly(wslHostsGateState() === 'serve-only')
}

export function resetWslHostsGateForTests(): void {
  promoted = null
  noteWslHostsServeOnly(false)
}

export function wslHostsGateState(): WslHostsGateState {
  return resolveWslHostsGateState({
    gateOpen: wslHostsGateOpen(),
    hasSavedWslHost: promoted?.hasSavedWslHost ?? false,
    hasWslMoveCutover: promoted?.hasWslMoveCutover ?? false
  })
}

/** Argv for any window on the shared preload, which cannot read the disk to learn serve-only. */
export function wslHostsWindowArguments(): string[] {
  return wslHostsGateState() === 'serve-only' ? [formatWslHostsServeOnlyArgument()] : []
}

/** The internal gate itself: adding hosts and starting moves need it. */
export function wslHostsGateOpen(): boolean {
  return isWslHostsInternalGateOpen(process.env)
}

/** Saved hosts and moved projects stay reachable: `open` or `serve-only`. */
export function wslHostsServing(): boolean {
  return wslHostsGateState() !== 'closed'
}

/** A persisted WSL host while the gate is closed: left on disk, but never listed or reached. */
export function isGatedOffWslHost(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): boolean {
  return environment.orcadDeployment?.kind === 'wsl' && !wslHostsServing()
}

export function assertWslHostReachable(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): void {
  if (isGatedOffWslHost(environment)) {
    throw new Error(WSL_HOSTS_GATED_OFF_MESSAGE)
  }
}

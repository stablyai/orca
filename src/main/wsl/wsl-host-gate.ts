import {
  formatWslHostsPolicyBlockedArgument,
  formatWslHostsServeOnlyArgument,
  isWslHostsInternalGateOpen,
  noteWslHostsPolicyBlocked,
  noteWslHostsServeOnly,
  publishWslHostsGateState,
  resolveWslHostsGateState,
  type WslHostsGateState
} from '../../shared/wsl-host-internal-gate'
import type { OrcadDeploymentLink } from '../../shared/runtime-environments'
import type { WslHostsMovedProjects, WslHostsPolicyState } from '../../shared/wsl-hosts-policy'

export const WSL_HOSTS_GATED_OFF_MESSAGE = 'WSL hosts are not available in this build.'

// Fixed for the run once main reads the disk; nothing can create a host or a move while not open.
let promoted: { hasSavedWslHost: boolean; hasWslMoveCutover: boolean } | null = null
// Also fixed for the run: a mid-run flip could pull a live host or an in-flight move from under the user.
let policyBlocked = false
// The cached remote policy this launch read; null when the internal gate was closed, so none was read.
let policyState: WslHostsPolicyState | null = null
// What a block asks for already-moved projects; `keep` whenever nothing blocks.
let movedProjects: WslHostsMovedProjects = 'keep'

// Unreadable state counts as absent: today's closed behavior.
function readFact(fact: () => boolean): boolean {
  try {
    return fact()
  } catch {
    return false
  }
}

// An unreadable policy is missing, which blocks nothing.
function readPolicy(read: (() => WslHostsPolicyState) | undefined): WslHostsPolicyState | null {
  if (!isWslHostsInternalGateOpen(process.env)) {
    return null
  }
  try {
    return read?.() ?? 'missing'
  } catch {
    return 'missing'
  }
}

function notePolicy(
  state: WslHostsPolicyState | null,
  moved: (() => WslHostsMovedProjects) | undefined
): void {
  policyState = state
  policyBlocked = state === 'block'
  noteWslHostsPolicyBlocked(policyBlocked)
  movedProjects = 'keep'
  if (policyBlocked && moved) {
    try {
      movedProjects = moved()
    } catch {
      // Unreadable: moved projects stay served, which is what a block alone does.
    }
  }
}

/**
 * Startup, before any gate check. A cached remote policy block closes an open internal gate, and a
 * closed gate with saved WSL work becomes `serve-only`, so blocking never strands a moved project.
 */
export function configureWslHostsGate(facts: {
  hasSavedWslHost: () => boolean
  hasWslMoveCutover: () => boolean
  policy?: () => WslHostsPolicyState
  /** Read only when the policy blocks. */
  movedProjects?: () => WslHostsMovedProjects
}): void {
  notePolicy(readPolicy(facts.policy), facts.movedProjects)
  promoted = wslHostsGateOpen()
    ? null
    : {
        hasSavedWslHost: readFact(facts.hasSavedWslHost),
        hasWslMoveCutover: readFact(facts.hasWslMoveCutover)
      }
  const state = wslHostsGateState()
  noteWslHostsServeOnly(state === 'serve-only')
  // Children inherit ORCA_INTERNAL_WSL_HOSTS even when a block closed it; this tells them the truth.
  publishWslHostsGateState(process.env, state)
}

export function resetWslHostsGateForTests(): void {
  promoted = null
  noteWslHostsServeOnly(false)
  notePolicy(null, undefined)
  publishWslHostsGateState(process.env, null)
  liveBlockNoted = false
  newWorkListeners.clear()
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
  return [
    ...(policyBlocked ? [formatWslHostsPolicyBlockedArgument()] : []),
    ...(wslHostsGateState() === 'serve-only' ? [formatWslHostsServeOnlyArgument()] : [])
  ]
}

/**
 * Stage 1 is opt-in: work that changes behaviour for projects the user already has needs the
 * WSL hosts setting on as well as the gate, so turning the setting off (rollback layer 1) undoes it.
 * A block learned this run undoes it too, the moment it lands.
 */
export function wslHostsOptedIn(
  settings: { experimentalWslHosts?: boolean } | null | undefined
): boolean {
  return settings?.experimentalWslHosts === true && wslHostsAcceptNewWork()
}

/** The internal gate itself, less a remote policy block: adding hosts and starting moves need it. */
export function wslHostsGateOpen(): boolean {
  return isWslHostsInternalGateOpen(process.env) && !policyBlocked
}

// A block the live policy fetch cached during this run. It stops new work at once; the gate
// itself (and so what is served) changes only at the next launch, so nothing is stranded.
let liveBlockNoted = false
const newWorkListeners = new Set<() => void>()

/** The live policy fetch cached a block this run; one-way until the next launch re-reads the cache. */
export function noteWslHostsLivePolicyBlock(): void {
  if (liveBlockNoted || !wslHostsGateOpen()) {
    return
  }
  liveBlockNoted = true
  for (const listener of newWorkListeners) {
    listener()
  }
}

export function onWslHostsNewWorkChanged(listener: () => void): () => void {
  newWorkListeners.add(listener)
  return () => newWorkListeners.delete(listener)
}

/** Adding hosts and starting moves: the gate open at launch, less a block learned since. */
export function wslHostsAcceptNewWork(): boolean {
  return wslHostsGateOpen() && !liveBlockNoted
}

/** The launch environment opened the gate, but the cached remote policy closed it for this run. */
export function wslHostsPolicyBlocked(): boolean {
  return policyBlocked
}

/** The cached remote policy this launch applied; null when the internal gate was closed. */
export function wslHostsAppliedPolicyState(): WslHostsPolicyState | null {
  return policyState
}

/** This run's block asks for already-moved projects to come back to this computer. */
export function wslHostsBringBackMovedProjects(): boolean {
  return movedProjects === 'bring-back'
}

/** What this run's block asks for moved projects; null when nothing blocks. */
export function wslHostsAppliedMovedProjects(): WslHostsMovedProjects | null {
  return policyBlocked ? movedProjects : null
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

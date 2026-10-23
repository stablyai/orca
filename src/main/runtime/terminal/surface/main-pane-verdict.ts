// Layout-owner builds: the liveness a main-owned pane's terminal.list row reports.

import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { paneTerminalFact, type RuntimePtyRegistryView } from '../../runtime-leaf-record-projection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { startedMainTerminalSurfaces, type SurfacesOwner } from './main-terminal-surfaces'

/** A pane main owns: its bound terminal, and whether a status says that binding is not live. */
export type MainPaneBinding = {
  ptyId: string | null
  hasStatus: boolean
  /** A start is in flight: the old binding's absence does not mean the pane's terminal ended. */
  starting: boolean
}

/**
 * The host's verdict on the pane's terminal. `exited` needs proof: the local inventory answered
 * without it, or the registry holds its exit. A pane with a status is never live.
 */
export function mainPaneVerdict(
  pane: MainPaneBinding,
  host: RuntimePtyRegistryView & {
    /** The local inventory's live terminals; null when it has not answered. */
    inventoryLivePtyIds: ReadonlySet<string> | null
    controllerHasPty: (ptyId: string) => boolean
  }
): PtyLivenessVerdict['status'] {
  // A start in flight: the old binding's end says nothing of the terminal now starting.
  if (pane.starting) {
    return 'unverifiable'
  }
  const verdict = provenAbsent(pane.ptyId, host)
    ? 'exited'
    : (paneTerminalFact(pane.ptyId, host) ?? 'unverifiable')
  return pane.hasStatus && verdict === 'live' ? 'unverifiable' : verdict
}

function provenAbsent(
  ptyId: string | null,
  host: Pick<Parameters<typeof mainPaneVerdict>[1], 'inventoryLivePtyIds' | 'controllerHasPty'>
): boolean {
  const inventory = host.inventoryLivePtyIds
  if (inventory === null) {
    return false
  }
  // An unbound pane runs nothing; the host answering is all that proves it.
  if (ptyId === null) {
    return true
  }
  // The local inventory cannot speak for an SSH or paired-server terminal.
  return (
    !inventory.has(ptyId) &&
    !isRemoteRuntimePtyId(ptyId) &&
    parseAppSshPtyId(ptyId) === null &&
    !host.controllerHasPty(ptyId)
  )
}

/**
 * Switch-on, a disconnected terminal main's layout still binds may run through a host's listing
 * gap, as the window kept it connected; a certified exit, or the host saying it cannot tell, ends it.
 */
export function mainBindsUnendedTerminal(
  runtime: SurfacesOwner,
  ptyId: string,
  recorded: { verdict: { status: string } } | undefined
): boolean {
  const status = recorded?.verdict.status
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    status !== 'exited' &&
    status !== 'unverifiable' &&
    mainHoldsTerminal(runtime, ptyId)
  )
}

/** Whether a pane main owns holds the terminal now: its workspace and stamped incarnation match. */
export function mainHoldsTerminal(runtime: SurfacesOwner, ptyId: string): boolean {
  return (startedMainTerminalSurfaces(runtime)?.findPaneForPty(ptyId) ?? null) !== null
}

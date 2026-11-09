import { carryProspectivePtySpawn } from '../../../pty/prospective-pty-spawn'
import type { PtySpawnOptions } from '../../../providers/pty-provider-contract'
import type { PaneSpawnOperation } from './pane-spawn-operation'
import type { LegacyTerminalRestoreAttempt } from '../../../pty/legacy-terminal-restore-ownership'

export const selectedIdentity = Symbol('selectedLegacyTerminalIdentity')
type Selection = { id: string; attempt: LegacyTerminalRestoreAttempt }
export type LegacyIdentityCarrier = Pick<PtySpawnOptions, 'cols' | 'rows'> & {
  [selectedIdentity]?: Selection
}

export function carrySelectedLegacyIdentity(
  source: LegacyIdentityCarrier,
  target: LegacyIdentityCarrier
): void {
  carryProspectivePtySpawn(source, target)
  const selection = source[selectedIdentity]
  if (selection) {
    Object.assign(target, { [selectedIdentity]: selection })
  }
}

export function assertSelectedLegacyIdentityOpen(options: LegacyIdentityCarrier): void {
  const selection = options[selectedIdentity]
  if (selection?.attempt.closed) {
    throw new Error('terminal_pane_owner_changed')
  }
}

export function selectedLegacyIdentity(
  options: LegacyIdentityCarrier | undefined
): Selection | undefined {
  return options?.[selectedIdentity]
}

export function legacyPaneRestoreAttempt(
  options: (LegacyIdentityCarrier & { paneSpawnOperation?: PaneSpawnOperation }) | undefined
): LegacyTerminalRestoreAttempt | undefined {
  return (
    selectedLegacyIdentity(options)?.attempt ?? options?.paneSpawnOperation?.legacyRestore?.attempt
  )
}

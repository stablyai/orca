import {
  getMachineActions,
  getMachineDisplayState,
  type MachineDisplayState
} from '../../../src/shared/machine-display'
import { machineMsUntilExpiry } from '../../../src/shared/machine-inventory'
import { colors } from '../theme/mobile-theme'
import type { MobileMachine } from './machine-operations'

const DAY_MS = 24 * 60 * 60_000
const LIFETIME_LABELS: Record<string, string> = {
  persistent: 'Persistent',
  temporary: 'Temporary'
}

export type MachineRowModel = {
  stateLabel: string
  stateColor: string
  subtitle: string
  action: 'wake' | 'sleep' | null
}

// Same vocabulary as the desktop: both read the state through the shared machine-display rules.
const STATE_LABELS: Record<MachineDisplayState, { label: string; color: string }> = {
  starting: { label: 'Starting', color: colors.statusAmber },
  running: { label: 'Running', color: colors.statusGreen },
  stopping: { label: 'Sleeping…', color: colors.statusAmber },
  sleeping: { label: 'Sleeping', color: colors.textMuted },
  archived: { label: 'Archived', color: colors.textMuted },
  error: { label: 'Error', color: colors.statusRed },
  unreachable: { label: 'Unreachable', color: colors.statusAmber },
  gone: { label: 'Gone', color: colors.statusRed }
}

// Why: a desktop too old to send its provider's verbs still served Wake and Sleep.
const VERBS_BEFORE_CAPABILITIES: readonly string[] = ['wake', 'sleep']

function expiryLabel(
  machine: MobileMachine,
  clockOffsetMs: number | undefined,
  now: number
): string | null {
  if (machine.lifetime !== 'temporary') {
    return null
  }
  const remaining = machineMsUntilExpiry(machine, clockOffsetMs, now)
  if (remaining === null || Number.isNaN(remaining)) {
    return null
  }
  if (remaining <= 0) {
    return 'expired'
  }
  const expiry = new Date(now + remaining)
  // A time alone reads as today; past a day out, name the date too.
  const label =
    remaining < DAY_MS
      ? expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : expiry.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          ...(expiry.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
          hour: 'numeric',
          minute: '2-digit'
        })
  return `deletes at ${label}`
}

export function machineRowModel(
  machine: MobileMachine,
  clockOffsetMs: number | undefined,
  now: number,
  verbs?: readonly string[]
): MachineRowModel {
  const state = STATE_LABELS[getMachineDisplayState(machine.state)]
  // A lifetime this build doesn't know shows nothing rather than a wrong word.
  const lifetime = LIFETIME_LABELS[machine.lifetime] ?? null
  const expiry = expiryLabel(machine, clockOffsetMs, now)
  return {
    stateLabel: state.label,
    stateColor: state.color,
    subtitle: [lifetime, expiry, machine.detail].filter(Boolean).join(' · '),
    // A phone acts as a paired client: the shared rules leave it Wake and Sleep alone.
    action:
      getMachineActions({
        state: machine.state,
        verbs: verbs ?? VERBS_BEFORE_CAPABILITIES,
        local: false,
        sshCommandAvailable: false
      }).find((action) => action === 'wake' || action === 'sleep') ?? null
  }
}

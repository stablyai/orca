import type {
  AgentLaunchFailureCode,
  AgentLaunchNoticeCode
} from '../../../src/shared/agent-launch-contract'
import { AGENT_LAUNCH_NOTICE_CODES } from '../../../src/shared/agent-launch-notice-schema'

// Domain outcome of a host-owned mobile resume, kept independent of the RPC
// envelope so the user-facing model stays stable while the transport shape is
// still settling. The flip wires wave2-host's createTerminal response into this.
export type MobileResumeOutcome =
  | { kind: 'launched'; notices?: readonly AgentLaunchNoticeCode[] }
  | { kind: 'failed'; code: AgentLaunchFailureCode }

// invalid_launch_snapshot is the only resume outcome that demands an explicit
// user choice: the saved launch details are gone, so the user opts in to a
// current-settings launch instead of a silent re-derivation (plan §570).
export type MobileResumeAffordance = {
  id: 'launch-current-settings'
  label: string
}

export type MobileResumeOutcomeDisplay = {
  tone: 'success' | 'info' | 'error'
  message: string
  action?: MobileResumeAffordance
}

const LAUNCH_CURRENT_SETTINGS: MobileResumeAffordance = {
  id: 'launch-current-settings',
  label: 'Launch with current settings'
}

// Maps a host-owned vault-resume createTerminal response to the domain outcome.
// Success is a PLAIN terminal (bypass) with no receipt, so there are never
// notices; a pre-spawn failure rides the agentLaunch failure arm (no tab). A
// `rejected` arm means the echoed identity was refused — a contract error, not a
// recoverable snapshot loss — so it surfaces as a generic, un-actionable failure.
export function readMobileVaultResumeCreateOutcome(result: unknown): MobileResumeOutcome {
  const envelope = result as {
    tab?: {
      launchNotices?: { notices?: Array<{ code?: unknown }> }
    }
    agentLaunch?: { status?: string; failure?: { code?: AgentLaunchFailureCode } } | null
  } | null
  const agentLaunch = envelope?.agentLaunch
  if (agentLaunch?.status === 'failed') {
    return { kind: 'failed', code: agentLaunch.failure?.code ?? 'spawn_failed' }
  }
  if (agentLaunch?.status === 'rejected') {
    return { kind: 'failed', code: 'spawn_failed' }
  }
  if (envelope?.tab) {
    const notices = (envelope.tab.launchNotices?.notices ?? [])
      .map((notice) => notice.code)
      .filter(
        (code): code is AgentLaunchNoticeCode =>
          typeof code === 'string' &&
          (AGENT_LAUNCH_NOTICE_CODES as readonly string[]).includes(code)
      )
    return notices.length > 0 ? { kind: 'launched', notices } : { kind: 'launched' }
  }
  return { kind: 'failed', code: 'spawn_failed' }
}

export function resolveMobileResumeOutcomeDisplay(
  outcome: MobileResumeOutcome
): MobileResumeOutcomeDisplay {
  if (outcome.kind === 'failed') {
    if (outcome.code === 'invalid_launch_snapshot') {
      return {
        tone: 'error',
        message: 'This session was saved with launch settings that are no longer available.',
        action: LAUNCH_CURRENT_SETTINGS
      }
    }
    return { tone: 'error', message: "Couldn't resume this session." }
  }
  const notices = outcome.notices ?? []
  const parts: string[] = []
  if (notices.includes('env_withheld')) {
    parts.push(
      "This launch didn't use all of the saved environment values. Manage paired-launch env on the desktop host."
    )
  }
  // Value-neutral by ruling: on mobile/paired snapshot_definition_changed can
  // only stem from label/argument/env-policy changes, never env-value changes.
  if (notices.includes('snapshot_definition_changed')) {
    parts.push('Resumed with the settings saved when this session started.')
  }
  if (notices.includes('vault_original_config_unavailable')) {
    parts.push('Original launch settings were unavailable, so current settings were used.')
  }
  if (parts.length === 0) {
    return { tone: 'success', message: 'Agent session queued.' }
  }
  return { tone: 'info', message: parts.join(' ') }
}

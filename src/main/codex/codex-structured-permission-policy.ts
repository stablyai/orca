import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'

export type CodexStructuredPermissionPolicy =
  | { approvalPolicy: 'never'; sandbox: 'danger-full-access' }
  | { approvalPolicy: 'on-request'; sandbox: 'workspace-write' }

/** Yolo: no approval prompts, no sandbox. */
const BYPASS_POLICY = { approvalPolicy: 'never', sandbox: 'danger-full-access' } as const

/**
 * Manual: approvals on, writes confined to the workspace.
 *
 * Why state it rather than omit it, which is what Manual used to do: app-server resolves an
 * omitted field through the `config.toml` it was started with, and Orca mirrors the user's
 * `~/.codex/config.toml` into the managed home it hands the app-server. Measured against codex
 * 0.153.4 — with `approval_policy = "never"` in that file, a FRESH Manual thread comes up
 * `never` + `dangerFullAccess` and never prompts. Manual was not a posture at all; it was
 * "inherit whatever the config says". A resume additionally inherits the policy the thread was
 * last started with, which is the path the bug was reported on; that half is not isolated here,
 * because staging a real Yolo thread needs a live turn before codex writes the rollout.
 *
 * Why `workspace-write` and not codex's built-in `read-only`: read-only would override a
 * deliberate `sandbox_mode = "workspace-write"` and make every file write in a Manual session
 * need an approval it did not need before. This still resets Yolo's `danger-full-access`.
 */
const MANUAL_POLICY = { approvalPolicy: 'on-request', sandbox: 'workspace-write' } as const

/**
 * The Agent Permissions setting as app-server thread policy.
 *
 * Derived per acquisition from the resolved launch arguments, never from the free-text Arguments
 * field: app-server takes a narrower option set than the interactive CLI and the two are versioned
 * apart, so the only thing read out of that field is the posture the toggle stores in it. An
 * untouched profile resolves to the default Orca ships, which is the bypass flag.
 *
 * Always a policy, never `undefined`: both postures have to be said out loud, because the one
 * that goes unsaid is the one a resume silently inherits from the other.
 */
export function codexStructuredPermissionPolicyForSettings(
  settings:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>
    | null
    | undefined
): CodexStructuredPermissionPolicy {
  return resolvedTuiAgentArgsBypassPermissions('codex', settings, process.platform)
    ? BYPASS_POLICY
    : MANUAL_POLICY
}

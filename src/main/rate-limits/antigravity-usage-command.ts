import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

/**
 * The quota read is a slash command run in print mode.
 *
 * Why print mode and not an HTTP call: agy keeps its Google credential in the OS keyring and mints
 * its own access token against `daily-cloudcode-pa`, so nothing outside agy can authenticate the
 * quota endpoint. Verified on agy 1.2.11: the call spends no quota and starts no conversation
 * (`num_turns: 0`, every token counter 0, empty `conversation_id`).
 *
 * `/usage` over `/quota`: both resolve to the same `usage` command, and `/usage` is the spelling agy
 * lists in its own help.
 */
export const ANTIGRAVITY_USAGE_ARGS: readonly string[] = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  // Why bound it inside agy too: the process timeout below kills a hung child, but agy's own
  // deadline lets it exit cleanly and print a diagnostic instead of dying mid-write.
  '--print-timeout',
  '20s'
  // Do NOT add --disable-slash-commands here. It stops agy expanding `/usage` as a command, so the
  // text is sent to the model as an ordinary prompt: the call then starts a conversation, spends
  // quota, and on an account near its limit returns RESOURCE_EXHAUSTED (429) instead of a reading.
  // Verified against agy 1.2.11 — the flag turned a free metadata read into a billed model turn.
]

/**
 * How long the child may run before Orca kills it.
 *
 * Observed cost on a warm macOS install is 2.1–2.6 s (three consecutive runs), which is the CLI
 * starting its language server and refreshing the quota. The ceiling is generous because a cold
 * start also pays a binary self-check, and the fetch runs on its own promise so a slow read delays
 * nothing else in the cycle.
 */
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 30_000

/**
 * Why 1.1.11: older agy answers `/usage` as a billable model turn instead of a quota report, so a
 * CLI below this floor must never see the usage args. The floor is compared as semver, so
 * `1.1.11-rc.1` stays below it and cannot spawn the read early.
 */
export const ANTIGRAVITY_MIN_USAGE_VERSION = '1.1.11'

/** The version probe; free in every sense — no conversation, no quota. */
export const ANTIGRAVITY_VERSION_ARGS: readonly string[] = ['--version']

/** Why bound it: the probe runs before every quota read, so a wedged CLI must not stall the cycle. */
export const ANTIGRAVITY_VERSION_TIMEOUT_MS = 5_000

/** Cap on captured output; the envelope is a single JSON line well under a kilobyte. */
export const ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES = 512 * 1024

/** The command name Orca already uses to detect Antigravity, so both agree on the binary. */
export function antigravityCommandName(): string {
  return TUI_AGENT_CONFIG.antigravity.detectCmd
}

/**
 * Why the args are never appended to a configured launch command: a user's Antigravity launch
 * command may carry its own flags, a wrapper script, or a shell pipeline, and appending `-p /usage`
 * to that either runs the wrong program or feeds the slash command to the wrong argv slot. The quota
 * read resolves the plain executable itself instead.
 */
export function isPlainAntigravityExecutable(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return false
  }
  return !/[\s"'|&;<>$`()]/.test(trimmed)
}

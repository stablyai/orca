import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

// Use agy print-mode /usage: only agy can authenticate daily-cloudcode-pa using its OS-keyring Google credential.
// agy 1.2.11 verified zero quota/tokens/turns and empty conversation_id; /usage and /quota resolve identically, but help lists /usage.
export const ANTIGRAVITY_USAGE_ARGS: readonly string[] = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  // Set agy’s own deadline too so a hung command can print diagnostics before process timeout kills it mid-write.
  '--print-timeout',
  '20s'
  // Never add --disable-slash-commands: agy 1.2.11 then sends /usage as a billed prompt and may answer 429 instead of quota.
]

// Warm macOS reads take 2.1–2.6s; allow cold binary self-check too. Fetch has its own promise, so slow reads do not block cycle.
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 30_000

// Disable background updater to avoid Windows console/focus theft (#27390) and CLI updates during quota probes; agy 1.4.2 requires true, not 1.
export const ANTIGRAVITY_PROBE_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } as const

// Before agy 1.1.11, `/usage` in print mode spends a model turn (agy's bundled changelog).
export const ANTIGRAVITY_MIN_USAGE_VERSION = '1.1.11'

// Version probe spends no quota and starts no conversation.
export const ANTIGRAVITY_VERSION_ARGS: readonly string[] = ['--version']

// Bound version probe so wedged CLI cannot stall every quota cycle.
export const ANTIGRAVITY_VERSION_TIMEOUT_MS = 5_000

// Each interactive sign-in read opens a browser (#26484); only a refresh or native credential change lifts this hold.
export const ANTIGRAVITY_SIGN_IN_HOLD_RETRY_AT_MS = Number.MAX_SAFE_INTEGER

/** Cap on captured output; the envelope is a single JSON line well under a kilobyte. */
export const ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES = 512 * 1024

// Use same Antigravity binary name as command detection.
export function antigravityCommandName(): string {
  return TUI_AGENT_CONFIG.antigravity.detectCmd
}

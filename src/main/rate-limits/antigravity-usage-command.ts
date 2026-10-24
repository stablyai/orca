import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

/** agy owns keyring credentials/token minting; /usage print mode reads quota without a conversation on supported versions.
 * /quota aliases it; /usage is the documented spelling (verified agy 1.2.11). */
export const ANTIGRAVITY_USAGE_ARGS: readonly string[] = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  // Let agy print a timeout diagnostic before Orca's outer process deadline.
  '--print-timeout',
  '20s'
  // Never use --disable-slash-commands: it turns /usage into a billed model prompt (verified agy 1.2.11).
]

/** Allow cold CLI self-check/startup; warm reads measured 2.1–2.6s and run independently of other fetches. */
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 30_000

/** Disable background updates: they can flash a Windows console and steal focus (#27390); agy 1.4.2 requires true, not 1. */
export const ANTIGRAVITY_PROBE_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } as const

// Before agy 1.1.11, `/usage` in print mode spends a model turn (agy's bundled changelog).
export const ANTIGRAVITY_MIN_USAGE_VERSION = '1.1.11'

export const ANTIGRAVITY_VERSION_ARGS: readonly string[] = ['--version']

/** Bound the per-read version probe so a wedged CLI cannot stall the cycle. */
export const ANTIGRAVITY_VERSION_TIMEOUT_MS = 5_000

export const ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES = 512 * 1024

export function antigravityCommandName(): string {
  return TUI_AGENT_CONFIG.antigravity.detectCmd
}

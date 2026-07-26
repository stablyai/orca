// Why: leave room for the supported 30,000-hook cleanup, including longer encoded Windows commands.
export const AGENT_HOOK_CONFIG_MAX_BYTES = 64 * 1024 * 1024
export const AGENT_HOOK_CONFIG_MAX_STRUCTURAL_TOKENS = 1_000_000
export const AGENT_HOOK_CONFIG_MAX_NESTING_DEPTH = 128
export const AGENT_HOOK_PLUGIN_MAX_BYTES = 1024 * 1024
export const AGENT_HOOK_MANAGED_SCRIPT_MAX_BYTES = 1024 * 1024

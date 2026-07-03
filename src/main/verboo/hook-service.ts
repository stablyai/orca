import { ClaudeHookService } from '../claude/hook-service'
import { VERBOO_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: Verboo emits Claude-compatible hooks; reuse ClaudeHookService so live
// status (thinking / in-flight tool / stop) reaches the sidebar with parity to
// OpenClaude, only differing in the ~/.verboo config dir and verboo-hook script.
export const verbooHookService = new ClaudeHookService({
  agent: 'verboo',
  displayName: 'Verboo',
  settings: VERBOO_HOOK_SETTINGS
})

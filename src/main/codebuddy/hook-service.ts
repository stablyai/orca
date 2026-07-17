import { ClaudeHookService } from '../claude/hook-service'
import { CODEBUDDY_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: CodeBuddy Code is built on the Claude Agent SDK and stores its
// Claude-shaped `settings.json` hooks in `~/.codebuddy` (verified via
// `codebuddy config set`). Reuse the generic Claude-compatible hook installer
// against that config dir, posting to the dedicated `/hook/codebuddy` source so
// status/resume attribution stays separate from Claude.
export const codebuddyHookService = new ClaudeHookService({
  agent: 'codebuddy',
  displayName: 'CodeBuddy',
  settings: CODEBUDDY_HOOK_SETTINGS,
  hookSource: 'codebuddy'
})

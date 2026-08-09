import { ClaudeHookService } from '../claude/hook-service'
import { QODERCLI_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: Qoder CLI (international) is Claude Code-compatible — it ships a
// `hooks migrate --from-claude` command — and reads hooks from
// ~/.qoder-cli/settings.json, so the Claude-compatible installer covers it.
export const qoderCliHookService = new ClaudeHookService({
  agent: 'qodercli',
  displayName: 'Qoder CLI',
  settings: QODERCLI_HOOK_SETTINGS
})

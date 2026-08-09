import { ClaudeHookService } from '../claude/hook-service'
import { QWEN_CODE_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: Qwen Code registers Claude-shaped command hooks in ~/.qwen/settings.json
// (https://github.com/QwenLM/qwen-code docs/users/features/hooks.md), so the
// Claude-compatible installer covers it; the settings carry Qwen's documented
// event subset rather than the OpenClaude-specific names.
export const qwenCodeHookService = new ClaudeHookService({
  agent: 'qwen-code',
  displayName: 'Qwen Code',
  settings: QWEN_CODE_HOOK_SETTINGS
})

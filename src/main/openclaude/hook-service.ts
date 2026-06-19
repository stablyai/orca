import { ClaudeHookService } from '../claude/hook-service'
import { OPENCLAUDE_HOOK_SETTINGS } from '../claude/hook-settings'

export const openClaudeHookService = new ClaudeHookService({
  agent: 'openclaude',
  displayName: 'OpenClaude',
  settings: OPENCLAUDE_HOOK_SETTINGS
})

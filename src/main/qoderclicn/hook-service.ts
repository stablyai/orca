import { ClaudeHookService } from '../claude/hook-service'
import { QODERCLICN_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: Qoder CLI CN (qoderclicn) is the CN build of the same Claude-compatible
// CLI with its own config root at ~/.qoder-cn/settings.json.
export const qoderCliCnHookService = new ClaudeHookService({
  agent: 'qoderclicn',
  displayName: 'Qoder CLI CN',
  settings: QODERCLICN_HOOK_SETTINGS
})

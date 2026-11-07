import { initClaudeUsagePath } from '../claude-usage/store'
import { initCodexUsagePath } from '../codex-usage/store'
import { initOpenCodeUsagePath } from '../opencode-usage/store'
import { initMuseUsagePath } from '../muse-usage/store'
import { initZcodeUsagePath } from '../zcode-usage/store'

export function initializeUsageStoragePaths(): void {
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  initMuseUsagePath()
  initZcodeUsagePath()
}

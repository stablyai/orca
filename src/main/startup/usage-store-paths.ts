import { initClaudeUsagePath } from '../claude-usage/store'
import { initCodexUsagePath } from '../codex-usage/store'
import { initOpenCodeUsagePath } from '../opencode-usage/store'
import { initMuseUsagePath } from '../muse-usage/store'
import { initPiUsagePath } from '../pi-usage/store'

export function initUsageStorePaths(): void {
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  initMuseUsagePath()
  initPiUsagePath()
}

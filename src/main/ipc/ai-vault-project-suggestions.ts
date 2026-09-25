import { ipcMain } from 'electron'
import { homedir, tmpdir } from 'node:os'
import type { Store } from '../persistence'
import type {
  AiVaultProjectSuggestion,
  AiVaultProjectSuggestionSource
} from '../../shared/ai-vault-project-suggestions'
import { gitExecFileAsync } from '../git/runner'
import { suggestProjectsFromSessions } from '../ai-vault/session-project-suggestions'

const MAX_SOURCES = 5_000
const MAX_PATH_LENGTH = 4_096

function parseSources(raw: unknown): AiVaultProjectSuggestionSource[] {
  const sources = typeof raw === 'object' && raw !== null && 'sources' in raw ? raw.sources : null
  if (!Array.isArray(sources)) {
    return []
  }
  return sources
    .slice(0, MAX_SOURCES)
    .filter(
      (source): source is AiVaultProjectSuggestionSource =>
        typeof source?.cwd === 'string' &&
        source.cwd.length > 0 &&
        source.cwd.length <= MAX_PATH_LENGTH &&
        typeof source.agent === 'string'
    )
}

// Why one rev-parse per folder: --git-common-dir folds worktrees into their repo and both flags
// exist in Git 2.25, the compatibility baseline.
async function resolveGitRoot(
  cwd: string
): Promise<{ toplevel: string; commonDir: string } | null> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--show-toplevel', '--git-common-dir'], {
    cwd
  })
  const [toplevel, commonDir] = stdout.split('\n').map((line) => line.trim())
  return toplevel && commonDir ? { toplevel, commonDir } : null
}

export function registerAiVaultProjectSuggestionHandler(store: Store): void {
  ipcMain.handle(
    'aiVault:suggestProjects',
    async (_event, raw: unknown): Promise<AiVaultProjectSuggestion[]> => {
      const settings = store.getSettings()
      return suggestProjectsFromSessions(
        {
          sources: parseSources(raw),
          registeredRepoPaths: store
            .getRepos()
            .filter((repo) => !repo.connectionId)
            .map((repo) => repo.path),
          dismissedPaths: settings.dismissedSessionProjectSuggestions ?? [],
          homeDir: homedir(),
          tempDirs: [...new Set([tmpdir(), '/tmp', '/var/tmp'])]
        },
        resolveGitRoot
      )
    }
  )
}

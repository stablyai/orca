import { ipcMain } from 'electron'
import { homedir, tmpdir } from 'node:os'
import type { Store } from '../persistence'
import type {
  AiVaultProjectSuggestion,
  AiVaultProjectSuggestionSource
} from '../../shared/ai-vault-project-suggestions'
import { gitExecFileAsync } from '../git/runner'
import { suggestProjectsFromSessions } from '../ai-vault/session-project-suggestions'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'

const KNOWN_AGENTS: ReadonlySet<string> = new Set(AI_VAULT_AGENTS)

// Why: renderer input is untrusted; only known agents may flow back typed as AiVaultAgent.
function isAiVaultAgent(value: unknown): value is AiVaultAgent {
  return typeof value === 'string' && KNOWN_AGENTS.has(value)
}

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
        isAiVaultAgent(source.agent)
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
          // Why POSIX-only: on Windows a rooted '/tmp' resolves to C:\tmp and would hide real repos.
          tempDirs: [
            ...new Set([tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp'])])
          ]
        },
        resolveGitRoot
      )
    }
  )
}

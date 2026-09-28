import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveOmpSessionsDir } from './omp-session-root'

// The default local roots for the two agents whose subagent transcripts are
// read back by renderer-supplied path (Claude and OMP). Discovery scans these;
// the IPC listers use the root enumerations below to reject arbitrary paths.
export const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// The local host and each WSL distro's `~/.claude/projects`. Callers reading
// Claude session files by path use these roots to reject arbitrary paths.
// `additionalClaudeProjectsDirs` covers `$CLAUDE_CONFIG_DIR/projects` and any
// extra account config dirs (multi-profile setups never use the default).
// Mirrors `additionalCodexSessionsDirs` for Codex.
export function claudeProjectsRootDirs(args: {
  claudeProjectsDir?: string
  additionalClaudeProjectsDirs?: readonly string[]
  wslHomeDirs?: readonly string[]
}): string[] {
  return uniqueSessionRootDirs([
    args.claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR,
    ...(args.additionalClaudeProjectsDirs ?? []),
    ...(args.wslHomeDirs ?? []).map((homeDir) => join(homeDir, '.claude', 'projects'))
  ])
}

function uniqueSessionRootDirs(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    const trimmed = path.trim()
    if (!trimmed) {
      continue
    }
    const key = resolve(trimmed)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

// The local host and each WSL distro's OMP sessions root. Callers reading OMP
// session files by path use these roots to reject arbitrary paths.
export function ompSessionsRootDirs(args: {
  ompSessionsDir?: string
  wslHomeDirs?: readonly string[]
}): string[] {
  return (
    sessionRootDirs(
      resolveOmpSessionsDir({ sessionsDir: args.ompSessionsDir }),
      normalizedWslHomeDirs(args.wslHomeDirs),
      ['.omp', 'agent', 'sessions']
    )
      // Why: OMP_CODING_AGENT_DIR='/' normalizes to '', which resolve()s to the
      // process cwd — an empty root would silently allowlist it.
      .filter((rootDir) => rootDir.trim().length > 0)
  )
}

export function normalizedWslHomeDirs(homeDirs: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const homeDir of homeDirs ?? []) {
    const trimmed = homeDir.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    unique.push(trimmed)
  }
  return unique
}

export function sessionRootDirs(
  hostRootDir: string,
  wslHomeDirs: readonly string[],
  segments: readonly string[]
): string[] {
  return [hostRootDir, ...wslHomeDirs.map((homeDir) => join(homeDir, ...segments))]
}

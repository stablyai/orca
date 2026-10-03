import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveOmpSessionsDir } from './omp-session-root'

// The default local roots for the two agents whose subagent transcripts are
// read back by renderer-supplied path (Claude and OMP). Discovery scans these;
// the IPC listers use the root enumerations below to reject arbitrary paths.
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// The local host and each WSL distro's `~/.claude/projects`. Callers reading
// Claude session files by path use these roots to reject arbitrary paths.
// Why both host roots and not just the config-dir one: adopting CLAUDE_CONFIG_DIR
// would otherwise hide every session written before it was set — the same
// managed-then-default shape as native-chat's claudeProjectsDirs
// (session-file-resolver.ts), de-duped so the usual case still scans once.
export function claudeProjectsRootDirs(args: {
  claudeProjectsDir?: string
  wslHomeDirs?: readonly string[]
  env?: NodeJS.ProcessEnv
}): string[] {
  const wslRoots = (args.wslHomeDirs ?? []).map((homeDir) => join(homeDir, '.claude', 'projects'))
  if (args.claudeProjectsDir !== undefined) {
    return [args.claudeProjectsDir, ...wslRoots]
  }
  // Why: Claude Code relocates its whole state root — projects/ included — under
  // CLAUDE_CONFIG_DIR, and orca itself sets it when launching an account-scoped
  // claude (cli/handlers/account.ts), so a scanner keyed only to ~/.claude misses
  // every non-default account's sessions (#23505). The env is injectable so tests
  // stay deterministic; WSL distro roots stay under each distro's home because the
  // host-side env says nothing about a distro's shell environment.
  const configDir = (args.env ?? process.env).CLAUDE_CONFIG_DIR?.trim()
  const hostCandidates = configDir
    ? [join(configDir, 'projects'), CLAUDE_PROJECTS_DIR]
    : [CLAUDE_PROJECTS_DIR]
  return [
    ...hostCandidates.filter((dir, index) => hostCandidates.indexOf(dir) === index),
    ...wslRoots
  ]
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

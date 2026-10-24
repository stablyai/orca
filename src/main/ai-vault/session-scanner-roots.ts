import { claudeProfileHistoryDirs } from '../claude-accounts/claude-profile-installed-router'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { resolveOmpSessionsDir } from './omp-session-root'

/** Where each transcript agent's session tree sits under a home dir (host or WSL guest). */
export const AGENT_SESSION_HOME_SEGMENTS = {
  claude: [['.claude', 'projects']],
  // Orca's retired WSL CODEX_HOME first: Orca-launched sessions were filed there.
  codex: [
    [...WSL_CODEX_RUNTIME_HOME_SEGMENTS, 'sessions'],
    ['.codex', 'sessions']
  ],
  grok: [['.grok', 'sessions']],
  omp: [['.omp', 'agent', 'sessions']]
} as const satisfies Record<string, readonly (readonly string[])[]>

export type SessionHomeAgent = keyof typeof AGENT_SESSION_HOME_SEGMENTS

/** Prefer the live config home while retaining default-home history from before the override. */
export function claudeProjectsHostDirs(): string[] {
  const defaultHome = join(homedir(), '.claude')
  return uniqueDirs([
    join(resolveAbsoluteDirOverride(process.env.CLAUDE_CONFIG_DIR, defaultHome), 'projects'),
    join(defaultHome, 'projects')
  ])
}

export function codexHomeSessionsDir(): string {
  return join(
    resolveAbsoluteDirOverride(process.env.CODEX_HOME, join(homedir(), '.codex')),
    'sessions'
  )
}

// Discovery and transcript path validation must agree on local, account and WSL roots.
export function claudeProjectsRootDirs(args: {
  claudeProjectsDir?: string
  wslHomeDirs?: readonly string[]
  /** Passed in by a scan worker, which has no account router of its own. */
  claudeProfileProjectsDirs?: readonly string[]
}): string[] {
  return uniqueDirs([
    ...(args.claudeProjectsDir ? [args.claudeProjectsDir] : claudeProjectsHostDirs()),
    ...wslHomeSessionDirs('claude', args.wslHomeDirs ?? []),
    ...(args.claudeProfileProjectsDirs ?? claudeProfileHistoryDirs('projects'))
  ])
}

export function wslHomeSessionDirs(
  agent: SessionHomeAgent,
  wslHomeDirs: readonly string[],
  joinUnderHome: (home: string, ...segments: string[]) => string = join
): string[] {
  return wslHomeDirs.flatMap((homeDir) =>
    AGENT_SESSION_HOME_SEGMENTS[agent].map((segments) => joinUnderHome(homeDir, ...segments))
  )
}

export function uniqueDirs(dirs: readonly string[]): string[] {
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index)
}

// Use these same roots for discovery and transcript path validation.
export function ompSessionsRootDirs(args: {
  ompSessionsDir?: string
  wslHomeDirs?: readonly string[]
}): string[] {
  return (
    [
      resolveOmpSessionsDir({ sessionsDir: args.ompSessionsDir }),
      ...wslHomeSessionDirs('omp', normalizedWslHomeDirs(args.wslHomeDirs))
    ]
      // Reject empty roots: normalizing OMP_CODING_AGENT_DIR=/ can otherwise allowlist the process cwd.
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

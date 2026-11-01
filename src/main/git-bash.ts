import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'
import { WINDOWS_GIT_BASH_SHELL } from '../shared/windows-terminal-shell'

type GitBashPathOptions = {
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value) {
      return value
    }
  }
  return undefined
}

function normalizePathSegment(segment: string): string {
  const trimmed = segment.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  candidate: string | undefined
): void {
  if (!candidate) {
    return
  }
  const normalized = pathWin32.normalize(candidate)
  const key = normalized.toLowerCase()
  if (!seen.has(key)) {
    seen.add(key)
    candidates.push(normalized)
  }
}

export function getGitBashCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const roots = [
    readEnv(env, ['ProgramFiles', 'PROGRAMFILES']),
    readEnv(env, ['ProgramW6432', 'PROGRAMW6432']),
    readEnv(env, ['ProgramFiles(x86)', 'PROGRAMFILES(X86)']),
    readEnv(env, ['LOCALAPPDATA', 'LocalAppData'])
  ]

  for (const root of roots) {
    if (!root) {
      continue
    }
    pushCandidate(candidates, seen, pathWin32.join(root, 'Git', 'bin', 'bash.exe'))
    pushCandidate(candidates, seen, pathWin32.join(root, 'Git', 'usr', 'bin', 'bash.exe'))
    pushCandidate(candidates, seen, pathWin32.join(root, 'Programs', 'Git', 'bin', 'bash.exe'))
    pushCandidate(
      candidates,
      seen,
      pathWin32.join(root, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
    )
  }

  const pathValue = readEnv(env, ['Path', 'PATH'])
  if (pathValue) {
    for (const rawSegment of pathValue.split(pathWin32.delimiter)) {
      const segment = normalizePathSegment(rawSegment)
      if (!segment) {
        continue
      }
      const directBashCandidate = pathWin32.join(segment, 'bash.exe')
      if (isGitForWindowsBashPath(directBashCandidate)) {
        pushCandidate(candidates, seen, directBashCandidate)
      }

      const basename = pathWin32.basename(segment).toLowerCase()
      const parent = pathWin32.dirname(segment)
      const parentBasename = pathWin32.basename(parent).toLowerCase()
      if (basename === 'cmd' && (parentBasename === 'git' || parentBasename === 'portablegit')) {
        pushCandidate(candidates, seen, pathWin32.join(parent, 'bin', 'bash.exe'))
        pushCandidate(candidates, seen, pathWin32.join(parent, 'usr', 'bin', 'bash.exe'))
      } else if (basename === 'git' || basename === 'portablegit') {
        pushCandidate(candidates, seen, pathWin32.join(segment, 'bin', 'bash.exe'))
        pushCandidate(candidates, seen, pathWin32.join(segment, 'usr', 'bin', 'bash.exe'))
      }
    }
  }

  return candidates
}

export function resolveGitBashPath(options: GitBashPathOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return null
  }
  const exists = options.exists ?? existsSync
  for (const candidate of getGitBashCandidatePaths(options.env ?? process.env)) {
    if (isGitForWindowsBashPath(candidate) && exists(candidate)) {
      return candidate
    }
  }
  return null
}

export function isGitBashAvailable(): boolean {
  return resolveGitBashPath() !== null
}

export function isGitForWindowsBashPath(shellPath: string): boolean {
  const normalized = pathWin32.normalize(shellPath).toLowerCase()
  return /(?:^|\\)(?:git|portablegit)(?:\\usr)?\\bin\\bash\.exe$/.test(normalized)
}

/** Distinguish Git for Windows install roots from Cygwin/MSYS2 using Git-specific launchers. */
const GIT_FOR_WINDOWS_ROOT_MARKERS = [
  ['usr', 'bin', 'bash.exe'],
  ['cmd', 'git.exe'],
  ['git-bash.exe']
] as const

/** bin/bash.exe launches usr/bin/bash.exe; unknown install names need layout-based detection. */
export function isGitForWindowsBashLauncherPath(
  shellPath: string,
  options: Pick<GitBashPathOptions, 'exists'> = {}
): boolean {
  const normalized = pathWin32.normalize(shellPath)
  if (/(?:^|\\)(?:git|portablegit)\\bin\\bash\.exe$/.test(normalized.toLowerCase())) {
    return true
  }
  const binDirectory = pathWin32.dirname(normalized)
  if (
    pathWin32.basename(normalized).toLowerCase() !== 'bash.exe' ||
    pathWin32.basename(binDirectory).toLowerCase() !== 'bin'
  ) {
    return false
  }
  // `usr\bin\bash.exe` lands here too, and is refused because no install root sits inside `usr`.
  const installRoot = pathWin32.dirname(binDirectory)
  const exists = options.exists ?? existsSync
  return GIT_FOR_WINDOWS_ROOT_MARKERS.every((marker) =>
    exists(pathWin32.join(installRoot, ...marker))
  )
}

export function resolveWindowsGitBashShellPath(
  shell: string,
  options: GitBashPathOptions = {}
): string | null {
  const trimmed = shell.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed === WINDOWS_GIT_BASH_SHELL) {
    return resolveGitBashPath(options)
  }

  // Accept both spellings used by resolveWindowsShellStartupFamily so launch and quoting agree.
  const shellBasename = pathWin32.basename(trimmed).toLowerCase()
  if (shellBasename !== 'bash.exe' && shellBasename !== 'bash') {
    return null
  }

  if (pathWin32.isAbsolute(trimmed) || trimmed.includes('\\') || trimmed.includes('/')) {
    // Reject stale configured paths before setup commits to a shell the PTY cannot spawn.
    const exists = options.exists ?? existsSync
    if (shellBasename === 'bash') {
      // Git for Windows ships bash.exe; confirm the synthesized extensionless-path target exists.
      const candidate = `${trimmed}.exe`
      return isGitForWindowsBashPath(candidate) && exists(candidate) ? candidate : null
    }
    return isGitForWindowsBashPath(trimmed) && exists(trimmed) ? trimmed : null
  }

  return resolveGitBashPath(options)
}

export function isWindowsGitBashShellPath(shellPath: string): boolean {
  return isGitForWindowsBashPath(shellPath)
}

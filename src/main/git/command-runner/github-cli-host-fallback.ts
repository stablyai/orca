import type { ResolvedCommand } from './wsl-command-resolution'

function hasExplicitRepoArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (
      (args[i] === '--repo' || args[i] === '-R') &&
      typeof args[i + 1] === 'string' &&
      args[i + 1].trim()
    ) {
      return true
    }
    if (args[i].startsWith('--repo=') || args[i].startsWith('-R=')) {
      return args[i].slice(args[i].indexOf('=') + 1).trim().length > 0
    }
    if (args[i].startsWith('-R') && args[i].length > 2) {
      return args[i].slice(2).trim().length > 0
    }
  }
  return false
}

function argsUseGhApiPlaceholders(args: string[]): boolean {
  return args.some(
    (arg) => arg.includes('{owner}') || arg.includes('{repo}') || arg.includes('{branch}')
  )
}

function hasExplicitRepoViewTarget(args: string[]): boolean {
  const target = args[2]
  return (
    args[0] === 'repo' &&
    args[1] === 'view' &&
    typeof target === 'string' &&
    !target.startsWith('-') &&
    target.includes('/')
  )
}

function canRunGitHubCliWithoutRepoCwd(args: string[]): boolean {
  if (hasExplicitRepoArg(args)) {
    return true
  }
  if (args[0] === 'api') {
    return !argsUseGhApiPlaceholders(args)
  }
  return args[0] === 'auth' || hasExplicitRepoViewTarget(args)
}

function isMissingCommandInWsl(stderr: string, command: string): boolean {
  const s = stderr.toLowerCase()
  const c = command.toLowerCase()
  return s.includes(`${c}: command not found`) || s.includes(`${c}: not found`)
}

export function canFallBackToHostGitHubCli(
  command: 'gh',
  args: string[],
  resolved: ResolvedCommand,
  stderr: string
): boolean {
  return (
    process.platform === 'win32' &&
    resolved.wsl !== null &&
    isMissingCommandInWsl(stderr, command) &&
    canRunGitHubCliWithoutRepoCwd(args)
  )
}

export function resolveHostGitHubCli(command: 'gh', args: string[]): ResolvedCommand {
  return {
    binary: command,
    args,
    // Why: host gh can't use a WSL UNC cwd; we only fall back for commands with explicit repo/API context, so none is needed.
    cwd: undefined,
    wsl: null,
    wslMode: null
  }
}

export function isHostCommandMissing(err: unknown, command: 'gh' | 'glab'): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const e = err as { code?: unknown; message?: unknown; syscall?: unknown; path?: unknown }
  if (e.code === 'ENOENT') {
    return true
  }
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return (
    message.includes('enoent') &&
    (message.includes(command) || e.path === command || e.syscall === 'spawn')
  )
}

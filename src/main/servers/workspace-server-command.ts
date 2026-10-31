import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import { validateWindowsCmdArguments } from '@orca/process-host/windows-command-line'
import { hostShellEnvironment } from '../runtime/structured-agent-shell-environment'
import {
  resolveWindowsShellStartupFamily,
  WINDOWS_GIT_BASH_SHELL
} from '../../shared/windows-terminal-shell'
import { resolveWindowsGitBashShellPath } from '../git-bash'

export function workspaceServerShellCommand(
  program: string,
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): Pick<PipedProcessSpec, 'program' | 'args' | 'windowsVerbatimArguments'> {
  if (platform === 'win32') {
    program = program.trim()
    const shellName = path.win32.basename(program).toLowerCase()
    if (shellName === 'wsl' || shellName === 'wsl.exe') {
      throw new Error(
        'Run managed WSL servers on a WSL Orca host, or select a native Windows shell. Windows-host server cleanup cannot verify Linux child termination.'
      )
    }
    const resolved = resolveWindowsGitBashShellPath(program, { platform, env })
    if (
      !resolved &&
      (program === WINDOWS_GIT_BASH_SHELL || /^(?:bash|bash\.exe)$/i.test(program))
    ) {
      throw new Error(
        'Git Bash was not found. Install Git for Windows or select another server shell.'
      )
    }
    program = resolved ?? program
  }
  const family = platform === 'win32' ? resolveWindowsShellStartupFamily(program) : 'posix'
  if (family === 'cmd') {
    validateWindowsCmdArguments([command])
    return { program, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
  }
  return {
    program,
    args:
      family === 'powershell'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        : [/(?:^|[/\\])(?:csh|tcsh|sh|dash)$/.test(program) ? '-c' : '-lc', command]
  }
}

export async function workspaceServerWorkingDirectory(
  rootPath: string,
  requestedCwd: string
): Promise<{ root: string; cwd: string }> {
  const root = await realpath(rootPath)
  const cwd = await realpath(path.resolve(root, requestedCwd))
  const relative = path.relative(root, cwd)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await stat(cwd)).isDirectory()
  ) {
    throw new Error('The server working directory must be inside its workspace.')
  }
  return { root, cwd }
}

export async function prepareWorkspaceServerCommand(args: {
  rootPath: string
  cwd: string
  command: string
  settings?: { terminalWindowsShell?: string; terminalDefaultShell?: string }
}): Promise<{ root: string; spec: PipedProcessSpec }> {
  const { root, cwd } = await workspaceServerWorkingDirectory(args.rootPath, args.cwd)
  const env = await hostShellEnvironment()
  const program =
    process.platform === 'win32'
      ? args.settings?.terminalWindowsShell || 'powershell.exe'
      : args.settings?.terminalDefaultShell || env.SHELL || '/bin/sh'
  return {
    root,
    spec: {
      ...workspaceServerShellCommand(program, args.command, process.platform, env),
      cwd,
      env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' }
    }
  }
}

// Production spawn for the setup-token runner: `claude setup-token` in a pseudo-terminal, because
// Claude's sign-in UI needs a TTY. Wide columns keep the printed token on one line.
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { resolveClaudeCommand, withCliRuntimeOnPath } from '../codex-cli/command'
import { buildClaudeChildProcessEnv } from '../claude/child-process/claude-child-process-environment'
import { buildWindowsCommandInvocation } from '../claude-accounts/sign-in/windows-command-invocation'
import { stripInheritedAgentSessionEnv } from '../../shared/agent-launch/startup/parent-agent-session-env'
import type { SetupTokenProcess, SpawnSetupToken } from './claude-setup-token-runner'

const COLUMNS = 1000

function enoent(): Error {
  return Object.assign(new Error('claude is not installed.'), { code: 'ENOENT' })
}

/**
 * What to run. Windows shims (.cmd) go through the command interpreter with the same quoting as
 * Orca's other Claude commands, handed to ConPTY as one verbatim command line.
 */
export function setupTokenInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] | string } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const invocation = buildWindowsCommandInvocation(command, ['setup-token'])
    return { file: invocation.command, args: invocation.args.join(' ') }
  }
  return { file: command, args: ['setup-token'] }
}

export const spawnClaudeSetupTokenPty: SpawnSetupToken = async () => {
  const command = resolveClaudeCommand()
  if (isAbsolute(command) && !(await stat(command).catch(() => null))) {
    throw enoent()
  }
  // Like Orca's other Claude children: no inherited auth overrides, no parent session stamps.
  const env: NodeJS.ProcessEnv = buildClaudeChildProcessEnv()
  stripInheritedAgentSessionEnv(env)
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(
    withCliRuntimeOnPath(command, { ...env, TERM: 'xterm-256color' })
  )) {
    if (value !== undefined) {
      childEnv[key] = value
    }
  }
  const { file, args } = setupTokenInvocation(command)
  const pty = await import('node-pty')
  let child: ReturnType<typeof pty.spawn>
  try {
    child = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: COLUMNS,
      rows: 40,
      cwd: homedir(),
      env: childEnv
    })
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    throw missing ? enoent() : error
  }
  const handle: SetupTokenProcess = {
    onData: (listener) => {
      child.onData(listener)
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => listener(exitCode))
    },
    kill: () => child.kill(),
    write: (data) => child.write(data)
  }
  return handle
}

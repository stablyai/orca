// Production spawn for the setup-token runner: `claude setup-token` in a pseudo-terminal, because
// Claude's sign-in UI needs a TTY. Wide columns keep the printed token on one line.
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolveClaudeCommand, withCliRuntimeOnPath } from '../codex-cli/command'
import { stripInheritedClaudeSessionEnv } from '../../shared/agent-launch/startup/claude-parent-session-env'
import type { SetupTokenProcess, SpawnSetupToken } from './claude-setup-token-runner'

const COLUMNS = 1000

function enoent(): Error {
  return Object.assign(new Error('claude is not installed.'), { code: 'ENOENT' })
}

export const spawnClaudeSetupTokenPty: SpawnSetupToken = async () => {
  const command = resolveClaudeCommand()
  if (isAbsolute(command) && !(await stat(command).catch(() => null))) {
    throw enoent()
  }
  const env: NodeJS.ProcessEnv = { ...process.env }
  stripInheritedClaudeSessionEnv(env)
  const childEnv = withCliRuntimeOnPath(command, { ...env, TERM: 'xterm-256color' })
  // Windows shims (.cmd) need the command interpreter; ConPTY can't start them directly.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const file = viaShell ? (process.env.ComSpec ?? 'cmd.exe') : command
  const args = viaShell ? ['/d', '/s', '/c', `"${command}" setup-token`] : ['setup-token']
  const pty = await import('node-pty')
  let child: ReturnType<typeof pty.spawn>
  try {
    child = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: COLUMNS,
      rows: 40,
      env: childEnv as Record<string, string>
    })
  } catch (error) {
    throw (error as { code?: unknown })?.code === 'ENOENT' ? enoent() : error
  }
  const process_: SetupTokenProcess = {
    onData: (listener) => {
      child.onData(listener)
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => listener(exitCode))
    },
    kill: () => child.kill()
  }
  return process_
}

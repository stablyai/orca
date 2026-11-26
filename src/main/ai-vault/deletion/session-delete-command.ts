import { runProcess } from '@orca/process-host'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCodexCommandForDelete } from '../../codex-cli/command'
import { resolveCliCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import {
  buildWslExecArgs,
  buildWslLoginShellCommand
} from '../../../shared/shell/wsl/wsl-login-shell-command'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { resolveWslExecutablePathAsync } from '../../wsl/execution/wsl-executable-path'
import { resolveWslInteropSpawnCwdAsync } from '../../wsl/execution/wsl-interop-spawn-directory'

const CLI_TIMEOUT_MS = 60_000
const WSL_CLI_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024

export type SessionDeleteCliResult =
  | { outcome: 'deleted' }
  | { outcome: 'not-found' }
  | { outcome: 'failed'; error: string }

/** Permanently delete a Codex rollout through its own CLI, on this host or inside a WSL distro. */
export async function deleteCodexSessionWithCli(args: {
  homePath: string
  sessionId: string
  wslDistro?: string
}): Promise<SessionDeleteCliResult> {
  const defaultStore =
    !args.wslDistro && resolve(args.homePath) === resolve(join(homedir(), '.codex'))
  return runDeleteCli({
    agent: 'codex',
    sessionId: args.sessionId,
    nativeEnv: defaultStore ? {} : { CODEX_HOME: args.homePath },
    clearInheritedEnv: defaultStore ? ['CODEX_HOME'] : [],
    ...(args.wslDistro ? { wsl: { distro: args.wslDistro, homePath: args.homePath } } : {})
  })
}

/** Delete an OpenCode session and its children through the OpenCode CLI. */
export async function deleteOpenCodeSessionWithCli(args: {
  dbPath: string
  sessionId: string
  wslDistro?: string
}): Promise<SessionDeleteCliResult> {
  const dataDir = dirnameOf(args.dbPath)
  const defaultStore =
    !args.wslDistro &&
    resolve(args.dbPath) === resolve(join(homedir(), '.local', 'share', 'opencode', 'opencode.db'))
  return runDeleteCli({
    agent: 'opencode',
    sessionId: args.sessionId,
    nativeEnv: defaultStore
      ? {}
      : {
          OPENCODE_DB: args.dbPath,
          ...(dataDir ? { XDG_DATA_HOME: dirnameOf(dataDir) } : {})
        },
    clearInheritedEnv: defaultStore ? ['OPENCODE_DB', 'XDG_DATA_HOME'] : [],
    standalone: !defaultStore,
    ...(args.wslDistro ? { wsl: { distro: args.wslDistro, dbPath: args.dbPath } } : {})
  })
}

async function runDeleteCli(args: {
  agent: 'codex' | 'opencode'
  sessionId: string
  nativeEnv: Record<string, string>
  clearInheritedEnv?: readonly string[]
  standalone?: boolean
  wsl?: { distro: string; homePath?: string; dbPath?: string }
}): Promise<SessionDeleteCliResult> {
  const result = args.wsl
    ? await runWslDelete(args)
    : await runNativeDelete(
        args.agent,
        args.sessionId,
        args.nativeEnv,
        args.clearInheritedEnv,
        args.standalone
      )
  return classifySessionDeleteResult(result)
}

async function runNativeDelete(
  agent: 'codex' | 'opencode',
  sessionId: string,
  env: Record<string, string>,
  clearInheritedEnv: readonly string[] = [],
  standalone = false
): Promise<{ code: number | null; output: string; timedOut: boolean; spawnError?: string }> {
  const program =
    agent === 'codex'
      ? await resolveCodexCommandForDelete()
      : await resolveCliCommandAsync('opencode')
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  for (const key of clearInheritedEnv) {
    delete childEnv[key]
  }
  try {
    const result = await runProcess(
      {
        program,
        args: deleteArgs(agent, sessionId, standalone),
        env: childEnv,
        timeoutMs: CLI_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES
      },
      'tail'
    )
    return {
      code: result.code,
      output: `${result.stdout}\n${result.stderr}`.trim(),
      timedOut: result.timedOut
    }
  } catch (error) {
    return {
      code: null,
      output: '',
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error)
    }
  }
}

async function runWslDelete(args: {
  agent: 'codex' | 'opencode'
  sessionId: string
  wsl?: { distro: string; homePath?: string; dbPath?: string }
}): Promise<{ code: number | null; output: string; timedOut: boolean; spawnError?: string }> {
  const wsl = args.wsl!
  const target = args.agent === 'codex' ? wsl.homePath : wsl.dbPath
  if (!target) {
    return { code: null, output: '', timedOut: false, spawnError: 'Missing WSL session store.' }
  }
  const assignments =
    args.agent === 'codex'
      ? `CODEX_HOME=${quotePosixShell(target)}`
      : [
          `OPENCODE_DB=${quotePosixShell(target)}`,
          `XDG_DATA_HOME=${quotePosixShell(dirnameOf(dirnameOf(target)))}`
        ].join(' ')
  const command = `${assignments} ${quotePosixShell(args.agent)} ${deleteArgs(
    args.agent,
    args.sessionId,
    true
  )
    .map(quotePosixShell)
    .join(' ')}`
  try {
    const result = await runProcess(
      {
        program: await resolveWslExecutablePathAsync(),
        args: buildWslExecArgs(wsl.distro, ['sh', '-c', buildWslLoginShellCommand(command)]),
        cwd: await resolveWslInteropSpawnCwdAsync(),
        env: { ...process.env, WSL_UTF8: '1' },
        timeoutMs: WSL_CLI_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES
      },
      'tail'
    )
    return {
      code: result.code,
      output: `${result.stdout}\n${result.stderr}`.trim(),
      timedOut: result.timedOut
    }
  } catch (error) {
    return {
      code: null,
      output: '',
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error)
    }
  }
}

function deleteArgs(agent: 'codex' | 'opencode', sessionId: string, standalone: boolean): string[] {
  return agent === 'codex'
    ? ['delete', '--force', sessionId]
    : ['session', 'delete', sessionId, ...(standalone ? ['--standalone'] : [])]
}

export function classifySessionDeleteResult(result: {
  code: number | null
  output: string
  timedOut: boolean
  spawnError?: string
}): SessionDeleteCliResult {
  if (result.spawnError) {
    return { outcome: 'failed', error: result.spawnError }
  }
  if (result.timedOut) {
    return { outcome: 'failed', error: 'Session delete command timed out.' }
  }
  if (result.code === 0) {
    return { outcome: 'deleted' }
  }
  if (
    result.output.includes('No active or archived session found matching') ||
    result.output.includes('Session not found')
  ) {
    return { outcome: 'not-found' }
  }
  return {
    outcome: 'failed',
    error: result.output || `Session delete command exited with code ${String(result.code)}.`
  }
}

function dirnameOf(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 ? path.slice(0, separator) : ''
}

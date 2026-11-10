import { spawnProcess } from '@orca/process-host'
import type { ClaudeStreamJsonLaunch } from './claude-stream-json-connection'
import { terminateClaudeProcess } from '../claude-accounts/claude-login-process-termination'
import {
  resolveExecutableCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'

export function createClaudeMcpLogin(
  launch: ClaudeStreamJsonLaunch,
  env: Record<string, string>,
  exited: Promise<unknown>
): (server: string) => Promise<void> {
  const controller = new AbortController()
  void exited.then(
    () => controller.abort(),
    () => controller.abort()
  )
  return (server) => loginClaudeMcp(launch, env, server, controller.signal)
}

/** Claude owns browser launch, callback and credential storage; no auth output enters Orca. */
export function loginClaudeMcp(
  launch: ClaudeStreamJsonLaunch,
  env: Record<string, string>,
  server: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('MCP sign-in cancelled'))
      return
    }
    const executable = launch.pathToClaudeCodeExecutable
    const pairedEnv = withCliRuntimeOnPath(executable, env)
    const script = /\.(?:js|mjs|ts|tsx|jsx)$/.test(executable)
    const program = script
      ? resolveExecutableCommand('node', { pathEnv: pairedEnv.PATH ?? pairedEnv.Path })
      : executable
    if (!program) {
      reject(new Error('Claude runtime is unavailable'))
      return
    }
    const child = spawnProcess({
      program,
      args: [
        ...(script ? [executable] : []),
        ...(launch.prefixArgs ?? []),
        'mcp',
        'login',
        '--',
        server
      ],
      cwd: launch.cwd,
      env: pairedEnv,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'ignore', 'ignore']
    })
    let settled = false
    let aborting = false
    const finish = (success: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      child.stdin?.destroy()
      if (success) {
        resolve()
      } else {
        reject(new Error('MCP sign-in did not complete'))
      }
    }
    const abort = () => {
      if (!settled) {
        aborting = true
        terminateClaudeProcess(child, null, () => finish(false))
      }
    }
    const timer = setTimeout(abort, 180_000)
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0 && !signal.aborted && !aborting))
    if (signal.aborted) {
      abort()
    }
  })
}

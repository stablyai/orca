import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type RemoteOrcaCliRequest = {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export type RemoteOrcaCliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

export async function runRemoteOrcaCli(
  runtime: OrcaRuntimeService,
  request: RemoteOrcaCliRequest
): Promise<RemoteOrcaCliResult> {
  const dispatcher = new RpcDispatcher({ runtime })
  const parsed = parseRemoteCliArgs(request.argv)
  const json = parsed.flags.has('json')

  try {
    const response = await dispatchRemoteCli(dispatcher, parsed, request.env)
    return {
      stdout: json ? `${JSON.stringify(response, null, 2)}\n` : `${formatRemoteCli(response)}\n`,
      stderr: '',
      exitCode: response.ok ? 0 : 1
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) {
      return {
        stdout: `${JSON.stringify(buildLocalError(message), null, 2)}\n`,
        stderr: '',
        exitCode: 1
      }
    }
    return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
  }
}

async function dispatchRemoteCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>
): Promise<RpcResponse> {
  const command = parsed.commandPath.join(' ')
  switch (command) {
    case 'status': {
      const response = await call(dispatcher, 'status.get')
      if (!response.ok) {
        return response
      }
      const status = response.result as RuntimeStatus
      const cliStatus: CliStatusResult = {
        app: { running: true, pid: null },
        runtime: {
          state: status.graphStatus === 'ready' ? 'ready' : 'graph_not_ready',
          reachable: true,
          runtimeId: status.runtimeId
        },
        graph: { state: status.graphStatus }
      }
      return { ...response, result: cliStatus }
    }
    case 'terminal list':
      return await call(dispatcher, 'terminal.list', {
        worktree: optionalString(parsed.flags, 'worktree'),
        limit: optionalNumber(parsed.flags, 'limit')
      })
    case 'orchestration send':
      return await call(dispatcher, 'orchestration.send', {
        from: resolveHandle(parsed.flags, env, 'from'),
        to: requiredString(parsed.flags, 'to'),
        subject: requiredString(parsed.flags, 'subject'),
        body: optionalString(parsed.flags, 'body'),
        type: optionalString(parsed.flags, 'type'),
        priority: optionalString(parsed.flags, 'priority'),
        threadId: optionalString(parsed.flags, 'thread-id'),
        payload: optionalString(parsed.flags, 'payload')
      })
    case 'orchestration check':
      return await call(dispatcher, 'orchestration.check', {
        terminal: resolveHandle(parsed.flags, env, 'terminal'),
        unread: parsed.flags.has('unread') ? true : undefined,
        all: parsed.flags.has('all') ? true : undefined,
        types: optionalString(parsed.flags, 'types'),
        inject: parsed.flags.has('inject') ? true : undefined,
        wait: parsed.flags.has('wait') ? true : undefined,
        timeoutMs: optionalNumber(parsed.flags, 'timeout-ms')
      })
    case 'orchestration reply':
      return await call(dispatcher, 'orchestration.reply', {
        id: requiredString(parsed.flags, 'id'),
        body: requiredString(parsed.flags, 'body'),
        from: resolveHandle(parsed.flags, env, 'from')
      })
    case 'orchestration inbox':
      return await call(dispatcher, 'orchestration.inbox', {
        limit: optionalNumber(parsed.flags, 'limit'),
        terminal: optionalString(parsed.flags, 'terminal')
      })
    default:
      throw new Error(`Unsupported SSH Orca CLI command: ${command}`)
  }
}

async function call(
  dispatcher: RpcDispatcher,
  method: string,
  params?: Record<string, unknown>
): Promise<RpcResponse> {
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method,
    params
  })
}

function parseRemoteCliArgs(argv: string[]): ParsedRemoteCli {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }
    const assignment = token.slice(2)
    // Why: the SSH relay-backed shim should accept the same `--flag=value`
    // form as the local CLI, including values that themselves start with `--`.
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex !== -1) {
      flags.set(assignment.slice(0, equalsIndex), assignment.slice(equalsIndex + 1))
      continue
    }

    const flag = assignment
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags.set(flag, next)
      i += 1
    } else {
      flags.set(flag, true)
    }
  }
  return { commandPath, flags }
}

function resolveHandle(
  flags: Map<string, string | boolean>,
  env: Record<string, string>,
  flagName: string
): string {
  return optionalString(flags, flagName) ?? env.ORCA_TERMINAL_HANDLE ?? 'unknown'
}

function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = optionalString(flags, name)
  if (!value) {
    throw new Error(`Missing --${name}`)
  }
  return value
}

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = optionalString(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatRemoteCli(response: RpcResponse): string {
  if (!response.ok) {
    return response.error.message
  }
  const result = response.result as Record<string, unknown>
  if ('app' in result && 'runtime' in result && 'graph' in result) {
    const status = result as CliStatusResult
    return [
      `appRunning: ${status.app.running}`,
      `pid: ${status.app.pid ?? 'none'}`,
      `runtimeState: ${status.runtime.state}`,
      `runtimeReachable: ${status.runtime.reachable}`,
      `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
      `graphState: ${status.graph.state}`
    ].join('\n')
  }
  return JSON.stringify(response.result)
}

function buildLocalError(message: string): RpcResponse {
  return {
    id: 'remote-cli-local',
    ok: false,
    error: { code: 'runtime_error', message },
    _meta: { runtimeId: 'unknown' }
  }
}

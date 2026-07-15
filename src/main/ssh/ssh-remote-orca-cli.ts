import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { formatRemoteCli } from './ssh-remote-cli-format'
import {
  HostCliUnavailableError,
  runHostOrcaCliPassthrough,
  type HostCliPassthroughOptions,
  type RemoteOrcaCliRequest,
  type RemoteOrcaCliResult
} from './ssh-remote-cli-host-passthrough'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import { getRemoteLinearHelp, tryDispatchRemoteLinearCli } from './ssh-remote-linear-cli'
import {
  getRemoteOrchestrationPayload,
  hasRemoteLifecycleRejection,
  resolveRemoteOrchestrationSender
} from './ssh-remote-orchestration-send'

export type { RemoteOrcaCliRequest, RemoteOrcaCliResult } from './ssh-remote-cli-host-passthrough'

// Why: these commands run a foreground/interactive process attached to the
// caller's TTY (or a local tmux pane), which a buffered one-shot relay bridge
// cannot host. Everything else routes through the full host CLI.
const HOST_INTERACTIVE_COMMANDS: Record<string, string> = {
  serve:
    'orca serve starts a foreground headless Orca server and cannot run through the SSH relay bridge. Run it directly on the machine that should host Orca.',
  'claude-teams':
    'orca claude-teams starts an interactive Claude Code session and cannot run through the SSH relay bridge. Run it in a terminal on the Orca host machine.',
  'agent-teams-tmux':
    'orca agent-teams-tmux is a tmux pane shim for the Orca host machine and cannot run through the SSH relay bridge.'
}

const REMOTE_BOOLEAN_FLAGS = new Set([
  'all',
  'attachments',
  'children',
  'comments',
  'current',
  'full',
  'help',
  'inject',
  'json',
  'me',
  'relations',
  'parent-current',
  'unread',
  'wait'
])
const REPEATED_FLAG_SEPARATOR = '\u0000'
const REPEATABLE_REMOTE_STRING_FLAGS = new Set(['label'])

export async function runRemoteOrcaCli(
  runtime: OrcaRuntimeService,
  request: RemoteOrcaCliRequest,
  passthroughOptions?: HostCliPassthroughOptions
): Promise<RemoteOrcaCliResult> {
  const parsed = parseRemoteCliArgs(request.argv)
  const json = parsed.flags.has('json')

  const interactiveMessage = HOST_INTERACTIVE_COMMANDS[parsed.commandPath[0] ?? '']
  if (interactiveMessage) {
    if (json) {
      return {
        stdout: `${JSON.stringify(buildLocalError(interactiveMessage, 'unsupported_over_ssh'), null, 2)}\n`,
        stderr: '',
        exitCode: 1
      }
    }
    return { stdout: '', stderr: `${interactiveMessage}\n`, exitCode: 1 }
  }

  let passthroughFailure: HostCliUnavailableError | null = null
  try {
    return await runHostOrcaCliPassthrough(request, passthroughOptions)
  } catch (err) {
    if (!(err instanceof HostCliUnavailableError)) {
      throw err
    }
    // Why: fall back to the legacy in-process command switch below so the
    // historical read-only/orchestration surface keeps working even when the
    // bundled CLI entry cannot be launched on this install.
    passthroughFailure = err
  }
  return await runLegacyRemoteOrcaCli(runtime, request, parsed, json, passthroughFailure)
}

async function runLegacyRemoteOrcaCli(
  runtime: OrcaRuntimeService,
  request: RemoteOrcaCliRequest,
  parsed: ParsedRemoteCli,
  json: boolean,
  passthroughFailure: HostCliUnavailableError
): Promise<RemoteOrcaCliResult> {
  const dispatcher = new RpcDispatcher({ runtime })
  const help = getRemoteLinearHelp(parsed)
  if (help) {
    return { stdout: `${help}\n`, stderr: '', exitCode: 0 }
  }

  try {
    const response = await dispatchRemoteCli(
      dispatcher,
      parsed,
      request.env,
      request.stdin,
      passthroughFailure.message
    )
    const formatted = json
      ? { stdout: `${JSON.stringify(response, null, 2)}\n`, stderr: '' }
      : formatRemoteCli(response)
    return {
      stdout: formatted.stdout,
      stderr: formatted.stderr,
      // Why: the legacy SSH bridge bypasses the local CLI handler that turns
      // a persisted lifecycle rejection into an unsuccessful command.
      exitCode: response.ok && !hasRemoteLifecycleRejection(response.result) ? 0 : 1
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof RemoteCliArgumentError
        ? err.code
        : err instanceof Error &&
            'code' in err &&
            typeof (err as { code: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'runtime_error'
    if (json) {
      return {
        stdout: `${JSON.stringify(buildLocalError(message, code), null, 2)}\n`,
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
  env: Record<string, string>,
  stdin: string | undefined,
  passthroughFailureReason: string
): Promise<RpcResponse> {
  const command = parsed.commandPath.join(' ')
  const linearResponse = await tryDispatchRemoteLinearCli(dispatcher, parsed, env, stdin)
  if (linearResponse) {
    return linearResponse
  }
  switch (command) {
    case 'status': {
      const response = await call(dispatcher, 'status.get')
      if (!response.ok) {
        return response
      }
      const status = response.result as RuntimeStatus
      const cliStatus: CliStatusResult = {
        app: {
          running: true,
          pid: null,
          ...(status.desktopWindowStatus ? { desktopWindowStatus: status.desktopWindowStatus } : {})
        },
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
    case 'orchestration send': {
      const type = optionalString(parsed.flags, 'type')
      return await call(dispatcher, 'orchestration.send', {
        from: resolveRemoteOrchestrationSender(parsed.flags, env, type),
        to: requiredString(parsed.flags, 'to'),
        subject: requiredString(parsed.flags, 'subject'),
        body: optionalString(parsed.flags, 'body'),
        type,
        priority: optionalString(parsed.flags, 'priority'),
        threadId: optionalString(parsed.flags, 'thread-id'),
        payload: getRemoteOrchestrationPayload(parsed.flags),
        // Why: the legacy in-process bridge must preserve the same pane
        // authority as the full host CLI passthrough.
        senderPaneKey: env.ORCA_PANE_KEY || undefined
      })
    }
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
      // Why: only reachable when the full host CLI could not be launched;
      // include that root cause so users can fix the install instead of
      // assuming the command family is unsupported over SSH.
      throw new Error(
        `Unsupported SSH Orca CLI command: ${command} (full Orca CLI bridge unavailable: ${passthroughFailureReason})`
      )
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
      setRemoteFlag(flags, assignment.slice(0, equalsIndex), assignment.slice(equalsIndex + 1))
      continue
    }

    const flag = assignment
    const next = argv[i + 1]
    if (!REMOTE_BOOLEAN_FLAGS.has(flag) && next && !next.startsWith('--')) {
      setRemoteFlag(flags, flag, next)
      i += 1
    } else {
      setRemoteFlag(flags, flag, true)
    }
  }
  return { commandPath, flags }
}

function setRemoteFlag(
  flags: Map<string, string | boolean>,
  name: string,
  value: string | boolean
): void {
  const previous = flags.get(name)
  if (
    typeof previous === 'string' &&
    typeof value === 'string' &&
    REPEATABLE_REMOTE_STRING_FLAGS.has(name)
  ) {
    flags.set(name, `${previous}${REPEATED_FLAG_SEPARATOR}${value}`)
    return
  }
  flags.set(name, value)
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
  if (!Number.isFinite(parsed)) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}

function buildLocalError(message: string, code = 'runtime_error'): RpcResponse {
  return {
    id: 'remote-cli-local',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'unknown' }
  }
}

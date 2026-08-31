import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { projectRemoteAppStatus } from '../../shared/cli-app-status-projection'
import { randomUUID } from 'node:crypto'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { RpcResponse } from '../runtime/rpc/core'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  HostCliUnavailableError,
  runHostOrcaCliPassthrough,
  type HostCliPassthroughOptions,
  type RemoteOrcaCliRequest,
  type RemoteOrcaCliResult
} from './ssh-remote-cli-host-passthrough'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import {
  optionalRemoteCliNumber,
  optionalRemoteCliString,
  parseRemoteCliArgs,
  requiredRemoteCliString,
  resolveRemoteCliHandle
} from './ssh-remote-cli-args'
import { buildRemoteCliError } from './ssh-remote-cli-error-response'
import { getRemoteLinearHelp, tryDispatchRemoteLinearCli } from './ssh-remote-linear-cli'
import {
  getRemoteOrchestrationPayload,
  resolveRemoteOrchestrationSender
} from './ssh-remote-orchestration-send'
import { formatInProcessRemoteCliResult } from './ssh-remote-cli-in-process-result'

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
    'orca agent-teams-tmux is a tmux pane shim for the Orca host machine and cannot run through the SSH relay bridge.',
  'account add':
    'orca account add runs an interactive agent login and cannot run through the buffered SSH relay bridge. Run it directly in a terminal on the Orca host machine.'
}

export async function runRemoteOrcaCli(
  runtime: OrcaRuntimeService,
  request: RemoteOrcaCliRequest,
  passthroughOptions?: HostCliPassthroughOptions
): Promise<RemoteOrcaCliResult> {
  const parsed = parseRemoteCliArgs(request.argv)
  const json = parsed.flags.has('json')
  const command = parsed.commandPath.join(' ')

  const interactiveMessage =
    HOST_INTERACTIVE_COMMANDS[command] ?? HOST_INTERACTIVE_COMMANDS[parsed.commandPath[0] ?? '']
  if (interactiveMessage && !parsed.flags.has('help')) {
    if (json) {
      return {
        stdout: `${JSON.stringify(buildRemoteCliError(interactiveMessage, 'unsupported_over_ssh'), null, 2)}\n`,
        stderr: '',
        exitCode: 1
      }
    }
    return { stdout: '', stderr: `${interactiveMessage}\n`, exitCode: 1 }
  }

  if (command === 'orchestration check' || command === 'orchestration ask') {
    // Why: compatibility ACKs must wait until relay stdout is observable; a host CLI child can only flush into main's capture pipe.
    return await runLegacyRemoteOrcaCli(
      runtime,
      request,
      parsed,
      json,
      new HostCliUnavailableError('output-ordered orchestration bridge required')
    )
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
  const dispatcher = new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS })
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
      passthroughFailure.message,
      request.runtimeAuthority
    )
    return formatInProcessRemoteCliResult(parsed, request.env, response, json)
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
        stdout: `${JSON.stringify(buildRemoteCliError(message, code), null, 2)}\n`,
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
  passthroughFailureReason: string,
  runtimeAuthority: RemoteOrcaCliRequest['runtimeAuthority']
): Promise<RpcResponse> {
  const command = parsed.commandPath.join(' ')
  const inheritedEvidence = readOrchestrationCompatibilityEvidence(env)
  const orchestrationCompatibilityEvidence = runtimeAuthority
    ? { ...inheritedEvidence, host: runtimeAuthority }
    : inheritedEvidence
  const compatibilityEnvelope: RuntimeOrchestrationEnvelope = {
    compatibilityInvocationId: randomUUID(),
    orchestrationRequestId:
      optionalRemoteCliString(parsed.flags, 'retry-request') ??
      (command === 'orchestration check' || command === 'orchestration ask'
        ? randomUUID()
        : undefined),
    orchestrationCompatibilityEvidence
  }
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
        target: { kind: 'environment', environment: 'ssh' },
        // Why: this answers for the Orca host the caller reached over SSH, not for the caller's
        // machine. It used to report running:true unconditionally, which claimed a desktop app
        // even for a headless `serve`; share the same projection the paired-server path uses so
        // both transports answer the question the same way (STA-4792 defect 4).
        app: projectRemoteAppStatus(status),
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
        worktree: optionalRemoteCliString(parsed.flags, 'worktree'),
        limit: optionalRemoteCliNumber(parsed.flags, 'limit'),
        // Why: agent JSON calls dominate; topology stays available through an explicit opt-in.
        includeVisualLayouts:
          !parsed.flags.has('json') || parsed.flags.has('include-visual-layouts')
      })
    case 'orchestration send': {
      const type = optionalRemoteCliString(parsed.flags, 'type')
      return await call(
        dispatcher,
        'orchestration.send',
        {
          from: resolveRemoteOrchestrationSender(parsed.flags, env, type),
          to: optionalRemoteCliString(parsed.flags, 'to'),
          subject: requiredRemoteCliString(parsed.flags, 'subject'),
          body: optionalRemoteCliString(parsed.flags, 'body'),
          type,
          priority: optionalRemoteCliString(parsed.flags, 'priority'),
          threadId: optionalRemoteCliString(parsed.flags, 'thread-id'),
          payload: getRemoteOrchestrationPayload(parsed.flags),
          // Why: the legacy in-process bridge must preserve the same pane
          // authority as the full host CLI passthrough.
          senderPaneKey: env.ORCA_PANE_KEY || undefined
        },
        {
          ...compatibilityEnvelope,
          orchestrationCapability: optionalRemoteCliString(parsed.flags, 'dispatch-capability')
        }
      )
    }
    case 'orchestration check':
      return await call(
        dispatcher,
        'orchestration.check',
        {
          terminal: resolveRemoteCliHandle(parsed.flags, env, 'terminal'),
          terminalPaneKey: parsed.flags.has('terminal')
            ? undefined
            : env.ORCA_PANE_KEY || undefined,
          unread: parsed.flags.has('unread') ? true : parsed.flags.has('peek') ? false : undefined,
          peek: parsed.flags.has('peek') ? true : undefined,
          all: parsed.flags.has('all') ? true : undefined,
          types: optionalRemoteCliString(parsed.flags, 'types'),
          format: parsed.flags.has('format') ? true : undefined,
          inject: parsed.flags.has('inject') ? true : undefined,
          compatibilityCliCommand: 'orca',
          run: optionalRemoteCliString(parsed.flags, 'run'),
          ack: optionalRemoteCliString(parsed.flags, 'ack'),
          wait: parsed.flags.has('wait') ? true : undefined,
          timeoutMs: optionalRemoteCliNumber(parsed.flags, 'timeout-ms')
        },
        compatibilityEnvelope
      )
    case 'orchestration ask':
      return await call(
        dispatcher,
        'orchestration.ask',
        {
          to: optionalRemoteCliString(parsed.flags, 'to'),
          question: optionalRemoteCliString(parsed.flags, 'question'),
          resume: optionalRemoteCliString(parsed.flags, 'resume'),
          options: optionalRemoteCliString(parsed.flags, 'options'),
          timeoutMs: optionalRemoteCliNumber(parsed.flags, 'timeout-ms'),
          from: resolveRemoteCliHandle(parsed.flags, env, 'from'),
          run: optionalRemoteCliString(parsed.flags, 'run'),
          compatibilityCliCommand: 'orca'
        },
        {
          ...compatibilityEnvelope,
          orchestrationCapability: optionalRemoteCliString(parsed.flags, 'dispatch-capability')
        }
      )
    case 'orchestration reply':
      return await call(
        dispatcher,
        'orchestration.reply',
        {
          id: requiredRemoteCliString(parsed.flags, 'id'),
          body: requiredRemoteCliString(parsed.flags, 'body'),
          from: resolveRemoteCliHandle(parsed.flags, env, 'from')
        },
        compatibilityEnvelope
      )
    case 'orchestration inbox':
      return await call(
        dispatcher,
        'orchestration.inbox',
        {
          limit: optionalRemoteCliNumber(parsed.flags, 'limit'),
          terminal: optionalRemoteCliString(parsed.flags, 'terminal')
        },
        compatibilityEnvelope
      )
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
  params?: Record<string, unknown>,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RpcResponse> {
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method,
    params,
    orchestrationCapability: envelope?.orchestrationCapability,
    orchestrationContractVersion: method.startsWith('orchestration.')
      ? ORCHESTRATION_CONTRACT_VERSION
      : undefined,
    orchestrationRequestId: envelope?.orchestrationRequestId,
    compatibilityInvocationId:
      envelope?.orchestrationRequestId ?? envelope?.compatibilityInvocationId,
    orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence
  })
}

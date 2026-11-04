/**
 * Serves the `orca orchestration` commands a relay-era terminal still runs, on this desktop's
 * runtime, where that terminal's Dispatch and Run records live.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Gated per host by "Allow this host's orca CLI to control Orca" and read on every call. Calls run
 * through a dispatcher that registers only the orchestration methods below, as a paired caller with
 * no grants (the desktop browser bridge's shape), after legacy-relay-cli-caller.ts bound them.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RpcResponse } from '../../runtime/rpc/core'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods'
import {
  assertLegacyRelayCliScope,
  resolveLegacyRelayCliCaller,
  type LegacyRelayCliCall,
  type LegacyRelayCliCaller
} from './legacy-relay-cli-caller'
import {
  messagePayload,
  numberFlag,
  parseLegacyRelayCliArgs,
  retryRequestFlag,
  stringFlag
} from './legacy-relay-cli-args'
import type { LegacyRelayCliServer } from './legacy-relay-client'
import { CONNECTOR_REPLY_UNAVAILABLE } from '../../../shared/rpc-contract/connector-params'
import {
  cappedInboxLimit,
  cappedWait,
  isExactLegacyRelayCliReplay,
  runLegacyRelayCliCall
} from './legacy-relay-cli-call-limits'
import { formatLegacyRelayCliResult, isRecord } from './legacy-relay-cli-output'
import type { LegacyRelayLivePane } from './legacy-relay-bridge-leases'

const METHODS: ReadonlySet<string> = new Set([
  'orchestration.check',
  'orchestration.inbox',
  'orchestration.send',
  'orchestration.ask',
  'orchestration.reply'
])

const COMMANDS: ReadonlySet<string> = new Set(
  [...METHODS].map((method) => method.replace('.', ' '))
)

export const LEGACY_RELAY_CLI_CONTROL_OFF =
  'This terminal was started by an older version of Orca. Its orca orchestration commands reach ' +
  'this desktop only when "Allow this host\'s orca CLI to control Orca" is on for this host in ' +
  'Settings > SSH. Otherwise, run them in a new terminal on this host.'

export const LEGACY_RELAY_CLI_UNSUPPORTED =
  'This terminal was started by an older version of Orca, so only orca orchestration check, ' +
  'inbox, send, ask and reply work in it. Run other orca commands in a new terminal on this host.'

const LEGACY_RELAY_CLI_HELP =
  'This terminal was started by an older version of Orca. It runs orca orchestration check, ' +
  'inbox, send, ask and reply; open a new terminal on this host for full orca help.'

type LegacyRelayCliServerDeps = {
  targetId: string
  runtime: () => OrcaRuntimeService | null
  /** The per-host switch, read on every call so turning it off applies to the next command. */
  remoteCliControl: () => boolean
  livePane: (paneKey: string) => LegacyRelayLivePane | null
}

const dispatchers = new WeakMap<OrcaRuntimeService, RpcDispatcher>()

function dispatcherFor(runtime: OrcaRuntimeService): RpcDispatcher {
  let dispatcher = dispatchers.get(runtime)
  if (!dispatcher) {
    dispatcher = new RpcDispatcher({
      runtime,
      // Restrict registration too, so upstream scope bugs cannot invoke unrelated methods.
      methods: ALL_RPC_METHODS.filter((method) => METHODS.has(method.name)),
      callerScope: { kind: 'runtime-paired', grants: [] }
    })
    dispatchers.set(runtime, dispatcher)
  }
  return dispatcher
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

/** The RPC the old CLI command names, with the caller bound from the verified pane. */
function buildCall(
  command: string,
  flags: Map<string, string | boolean>,
  caller: LegacyRelayCliCaller
): LegacyRelayCliCall {
  const flag = (name: string) => stringFlag(flags, name)
  const has = (name: string) => flags.has(name)
  const self = { terminal: flag('terminal') ?? caller.handle }
  switch (command) {
    case 'orchestration check':
      return {
        method: 'orchestration.check',
        params: {
          ...self,
          terminalPaneKey: caller.paneKey,
          unread: has('unread') ? true : has('peek') ? false : undefined,
          peek: has('peek') ? true : undefined,
          all: has('all') ? true : undefined,
          types: flag('types'),
          format: has('format') ? true : undefined,
          inject: has('inject') ? true : undefined,
          compatibilityCliCommand: 'orca',
          run: flag('run'),
          ack: flag('ack'),
          wait: has('wait') ? true : undefined,
          timeoutMs: cappedWait(numberFlag(flags, 'timeout-ms'))
        }
      }
    case 'orchestration inbox':
      return {
        method: 'orchestration.inbox',
        params: { ...self, limit: cappedInboxLimit(numberFlag(flags, 'limit')) }
      }
    case 'orchestration send':
      return {
        method: 'orchestration.send',
        params: {
          from: flag('from') ?? caller.handle,
          to: flag('to'),
          subject: flag('subject'),
          body: flag('body'),
          type: flag('type'),
          priority: flag('priority'),
          threadId: flag('thread-id'),
          payload: messagePayload(flags),
          senderPaneKey: caller.paneKey,
          run: flag('run')
        }
      }
    case 'orchestration ask':
      return {
        method: 'orchestration.ask',
        params: {
          from: flag('from') ?? caller.handle,
          to: flag('to'),
          run: flag('run'),
          question: flag('question'),
          resume: flag('resume'),
          options: flag('options'),
          timeoutMs: cappedWait(numberFlag(flags, 'timeout-ms')),
          compatibilityCliCommand: 'orca'
        }
      }
    case 'orchestration reply':
      return {
        method: 'orchestration.reply',
        params: {
          id: flag('id'),
          body: flag('body'),
          from: flag('from') ?? caller.handle,
          run: flag('run')
        }
      }
    default:
      throw new Error(LEGACY_RELAY_CLI_UNSUPPORTED)
  }
}

/** Its own receipt namespace per host terminal: a host can never replay another caller's result. */
function callerFingerprint(targetId: string, env: Record<string, string>): string {
  return createHash('sha256')
    .update(['legacy-relay-cli-v1', targetId, env.ORCA_TERMINAL_HANDLE ?? ''].join('\0'))
    .digest('hex')
}

type Invocation = {
  runtime: OrcaRuntimeService
  caller: LegacyRelayCliCaller
  env: Record<string, string>
  fingerprint: string
  signal: AbortSignal
}

async function dispatchAsCaller(
  deps: LegacyRelayCliServerDeps,
  { runtime, caller, env, fingerprint, signal }: Invocation,
  call: LegacyRelayCliCall,
  requestId: string
): Promise<RpcResponse> {
  // Attach verified identity because the runtime no longer hosts this legacy terminal.
  const authority = runtime.registerOrchestrationCompatibilitySshAttachment(
    deps.targetId,
    `legacy-relay:${randomUUID()}`,
    {
      handle: caller.handle,
      paneKey: caller.paneKey,
      ...(caller.processIncarnation ? { processIncarnation: caller.processIncarnation } : {})
    }
  )
  try {
    // Only exact committed mutations replay after assignment changes; all other calls remain scoped.
    const exactReplay = isExactLegacyRelayCliReplay(runtime, fingerprint, requestId, call)
    const db = runtime.getOrchestrationDb()
    assertLegacyRelayCliScope(db, caller, call, deps.livePane, exactReplay)
    const launchToken = env.ORCA_AGENT_LAUNCH_TOKEN?.trim()
    return await dispatcherFor(runtime).dispatch(
      {
        id: `legacy-relay-cli-${requestId}`,
        authToken: 'legacy-relay-cli',
        method: call.method,
        params: call.params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: requestId,
        compatibilityInvocationId: requestId,
        orchestrationCompatibilityEvidence: {
          terminalHandle: caller.handle,
          paneKey: caller.paneKey,
          ...(launchToken ? { launchToken } : {}),
          host: authority
        }
      },
      { signal, authenticatedCallerFingerprint: fingerprint }
    )
  } finally {
    runtime.releaseOrchestrationCompatibilitySshAttachment(authority.attachmentId)
  }
}

function admit(
  deps: LegacyRelayCliServerDeps,
  env: Record<string, string>,
  signal: AbortSignal,
  replayRequestId?: string
): Invocation {
  const runtime = deps.runtime()
  if (!deps.remoteCliControl() || !runtime) {
    throw new Error(LEGACY_RELAY_CLI_CONTROL_OFF)
  }
  const fingerprint = callerFingerprint(deps.targetId, env)
  const replay = replayRequestId ? { fingerprint, requestId: replayRequestId } : undefined
  const caller = resolveLegacyRelayCliCaller(runtime, env, deps.livePane, deps.targetId, replay)
  return { runtime, caller, env, fingerprint, signal }
}

export function createLegacyRelayCliServer(deps: LegacyRelayCliServerDeps): LegacyRelayCliServer {
  return {
    cli: (params, relaySignal) =>
      runLegacyRelayCliCall(deps.targetId, deps.remoteCliControl, relaySignal, (signal) =>
        serveCli(deps, params, signal)
      ),
    postOutput: (params, relaySignal) =>
      runLegacyRelayCliCall(deps.targetId, deps.remoteCliControl, relaySignal, (signal) =>
        servePostOutput(deps, params, signal)
      )
  }
}

async function serveCli(
  deps: LegacyRelayCliServerDeps,
  params: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const env = stringRecord(params.env)
  const argv = Array.isArray(params.argv)
    ? params.argv.filter((item): item is string => typeof item === 'string')
    : []
  const { command, flags } = parseLegacyRelayCliArgs(argv)
  // Handle help before execution so valid commands cannot apply effects with --help.
  if (flags.has('help') || argv.includes('-h')) {
    return { stdout: `${LEGACY_RELAY_CLI_HELP}\n`, stderr: '', exitCode: 0 }
  }
  if (!COMMANDS.has(command)) {
    throw new Error(
      command === 'connector reply' ? CONNECTOR_REPLY_UNAVAILABLE : LEGACY_RELAY_CLI_UNSUPPORTED
    )
  }
  const retryRequestId = retryRequestFlag(flags)
  const invocation = admit(deps, env, signal, retryRequestId)
  const call = buildCall(command, flags, invocation.caller)
  const requestId = retryRequestId ?? randomUUID()
  const response = await dispatchAsCaller(deps, invocation, call, requestId)
  return formatLegacyRelayCliResult(call, response, invocation.caller, flags)
}

async function servePostOutput(
  deps: LegacyRelayCliServerDeps,
  params: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const env = stringRecord(params.env)
  const invocation = admit(deps, env, signal)
  const { caller } = invocation
  const post = isRecord(params.postOutput) ? params.postOutput : {}
  const ack =
    post.kind === 'legacy_check_ack' && Array.isArray(post.messageIds)
      ? {
          compatibilityAck: JSON.stringify({
            messageIds: post.messageIds.filter((id) => typeof id === 'string'),
            ...(Array.isArray(post.types)
              ? { types: post.types.filter((type) => typeof type === 'string') }
              : {})
          })
        }
      : post.kind === 'legacy_question_ack' &&
          typeof post.questionId === 'string' &&
          typeof post.answerMessageId === 'string'
        ? {
            compatibilityQuestionAck: JSON.stringify({
              questionId: post.questionId,
              answerMessageId: post.answerMessageId
            })
          }
        : null
  if (!ack) {
    throw new Error('Invalid SSH CLI post-output action.')
  }
  const call = { method: 'orchestration.check', params: { terminal: caller.handle, ...ack } }
  const response = await dispatchAsCaller(deps, invocation, call, randomUUID())
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return { acknowledged: true }
}

/* eslint-disable max-lines -- Why: orchestration CLI handlers share flag-parsing helpers and dispatch/preamble logic; splitting by verb would fragment the RuntimeClient call shape without reducing complexity. */
import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { requireWorkerDoneSettlement } from './orchestration-worker-settlement'
import { getTerminalHandle } from '../selectors'
import {
  clampOrchestrationAskTimeoutMs,
  resolveOrchestrationAskClientTimeoutMs
} from '../../shared/orchestration-ask-timeout'
import { abbreviateOrchestrationTasks } from '../../shared/orchestration-task-summary'
import { parsePositiveSafeIntegerText } from '../../shared/timer-delay'
import type {
  OrchestrationWorkerReadResult,
  OrchestrationWorkerReadSource
} from '../../shared/orchestration-worker-output'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { RuntimeStatus, RuntimeTerminalRead } from '../../shared/runtime-types'
import type { CodexRateLimitAccountsState } from '../../shared/types'
import type { GitStatusResult } from '../../shared/git-status-types'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { orchestrationMigrationData } from '../../shared/orchestration-rpc-contract'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../shared/orchestration-run-pagination'
import {
  formatMessageReadOnlyTag,
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput,
  type LegacyCompatibilityResult,
  type OrchestrationMessageSummary as MessageSummary,
  type OrchestrationCheckOutput
} from '../../shared/orchestration-check-output'
import {
  posixShellQuote,
  buildAcceptancePayload,
  evaluateWorktreeClosure,
  isCodexQuotaExhaustedText,
  isCodexQuotaExhaustedRead,
  lifecycleMessageForDispatch,
  parseAccountOrder,
  resolveCodexAccount,
  boundedPollDelayMs
} from '../orchestration-interaction-loop'

// Why: 15 s is well under Claude Code's ~2 min Bash-tool silence budget while keeping log volume low. See design doc §3.4.
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000
function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

// Why: test-only escape hatch so subprocess tests avoid the full 15 s window; bogus values fall back to the default.
function resolveKeepaliveIntervalMs(): number {
  const raw = process.env.ORCA_KEEPALIVE_INTERVAL_MS ?? process.env.ORCA_HEARTBEAT_INTERVAL_MS
  if (!raw) {
    return DEFAULT_KEEPALIVE_INTERVAL_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_KEEPALIVE_INTERVAL_MS
  }
  return parsed
}

function startCheckKeepalive(deadlineMs: number | undefined): () => void {
  const startedAt = Date.now()
  const interval = setInterval(() => {
    const payload = {
      _keepalive: true,
      // Why: retain the old marker for scripts still filtering it while callers migrate to _keepalive.
      _heartbeat: true,
      elapsedMs: Date.now() - startedAt,
      deadlineMs: deadlineMs ?? null
    }
    // Why: process.stderr.write is line-flushed per-call in Node; a buffered writer would hold keepalives until exit. See §3.4.
    process.stderr.write(`${JSON.stringify(payload)}\n`)
  }, resolveKeepaliveIntervalMs())
  if (typeof interval.unref === 'function') {
    interval.unref()
  }
  return () => clearInterval(interval)
}

// Why: mirrors TaskStatus (orchestration/types.ts) so the CLI surfaces an enum-aware error before the generic RPC message.
const TASK_STATUS_VALUES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

// Why: mirrors WorkerTerminalListState (orchestration/types.ts) so a bad --terminal-state fails before the RPC.
const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

type LifecycleSendResult =
  | {
      action: 'completed' | 'failed'
      authority?: 'run_home' | 'worker_server_legacy'
    }
  | { action: 'settled'; outcome: 'succeeded' | 'failed'; duplicate?: boolean }
  | { action: 'rejected'; code: string; reason: string }

type OrchestrationSendResult =
  | {
      message: { id: string; run_id?: string }
      lifecycle?: LifecycleSendResult
    }
  | { messages: { id: string }[]; recipients: number }
  | {
      relay: {
        messageId: string
        sequence: number
        dispatchId: string
        destination?: 'run_home' | 'worker'
        accepted: true
      }
      lifecycle?: LifecycleSendResult
    }

function resolveCompatibilityCliCommand(): 'orca' | 'orca-ide' | 'orca-dev' {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured === 'orca' || configured === 'orca-ide' || configured === 'orca-dev') {
    return configured
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

function resolvePackagedWindowsCompatibilityCommand(): 'orca' | 'orca-ide' | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command === 'orca' || command === 'orca-ide') {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Orca launcher did not provide a valid resume command. No question was created.'
  )
}

async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

function getOptionalStructuredMessagePayload(
  flags: Map<string, string | boolean>
): string | undefined {
  const rawPayload = getOptionalStringFlag(flags, 'payload')
  const taskId = getOptionalStringFlag(flags, 'task-id')
  const dispatchId = getOptionalStringFlag(flags, 'dispatch-id')
  const outcome = getOptionalStringFlag(flags, 'outcome')
  const filesModified = getOptionalStringFlag(flags, 'files-modified')
  const reportPath = getOptionalStringFlag(flags, 'report-path')
  const phase = getOptionalStringFlag(flags, 'phase')
  const hasStructuredPayload =
    taskId !== undefined ||
    dispatchId !== undefined ||
    outcome !== undefined ||
    filesModified !== undefined ||
    reportPath !== undefined ||
    phase !== undefined
  if (!hasStructuredPayload) {
    return rawPayload
  }
  if (rawPayload !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --payload or structured payload flags, not both.'
    )
  }
  // Why: raw JSON args are fragile in Windows PowerShell; these flags avoid shell-specific quoting.
  const payload: Record<string, string | string[]> = {}
  if (taskId) {
    payload.taskId = taskId
  }
  if (dispatchId) {
    payload.dispatchId = dispatchId
  }
  if (outcome) {
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Invalid --outcome. Expected succeeded or failed.'
      )
    }
    payload.outcome = outcome
  }
  if (filesModified) {
    payload.filesModified = filesModified
      .split(',')
      .map((file) => file.trim())
      .filter(Boolean)
  }
  if (reportPath) {
    payload.reportPath = reportPath
  }
  if (phase) {
    payload.phase = phase
  }
  return JSON.stringify(payload)
}

async function resolveOrchestrationTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client'],
  flagName: 'from' | 'terminal',
  options: { validateEnvHandle?: boolean } = {}
): Promise<string> {
  const explicit = getOptionalStringFlag(flags, flagName)
  if (explicit) {
    return explicit
  }
  const envHandle = process.env.ORCA_TERMINAL_HANDLE
  if (envHandle && envHandle.length > 0) {
    if (flagName === 'from' && options.validateEnvHandle) {
      // Why: long-lived shells can retain a stale ORCA_TERMINAL_HANDLE after remint; don't bake it into coordinator preambles.
      const live = await isLiveTerminalHandle(envHandle, client)
      if (!live) {
        const reminted = await resolveOrchestrationPaneTerminalHandle(client)
        if (reminted) {
          return reminted
        }
        throwNoActiveSenderTerminal()
      }
    }
    return envHandle
  }
  if (flagName === 'from') {
    return await resolveImplicitOrchestrationSender(flags, cwd, client)
  }
  return await getTerminalHandle(flags, cwd, client)
}

async function isLiveTerminalHandle(
  handle: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<boolean> {
  try {
    await client.call('terminal.show', { terminal: handle })
    return true
  } catch (err) {
    if (isStaleTerminalIdentityError(err)) {
      return false
    }
    throw err
  }
}

function getClientErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined
  }
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isStaleTerminalIdentityError(err: unknown): boolean {
  const code = getClientErrorCode(err)
  return code === 'terminal_handle_stale' || code === 'terminal_gone'
}

function isNoActiveTerminalError(err: unknown): boolean {
  return getClientErrorCode(err) === 'no_active_terminal'
}

async function resolveOrchestrationPaneTerminalHandle(
  client: Parameters<CommandHandler>[0]['client'],
  options: { optional?: boolean } = {}
): Promise<string | undefined> {
  const paneKey = process.env.ORCA_PANE_KEY
  if (!paneKey || paneKey.length === 0) {
    return undefined
  }
  try {
    // Why: pane-key reminting preserves caller identity; focus-based active-terminal fallback can point at a different pane.
    const response = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
      paneKey
    })
    return response.result.terminal.handle
  } catch (err) {
    if (
      isPaneRemintUnavailableError(err) ||
      (options.optional === true && isOptionalPaneRemintUnavailableError(err))
    ) {
      return undefined
    }
    throw err
  }
}

function isPaneRemintUnavailableError(err: unknown): boolean {
  const code = getClientErrorCode(err)
  const message = getClientErrorMessage(err)
  return (
    code === 'terminal_not_found' ||
    code === 'terminal_handle_stale' ||
    code === 'terminal_gone' ||
    message === 'terminal_not_found' ||
    message === 'terminal_handle_stale' ||
    message === 'terminal_gone'
  )
}

function isOptionalPaneRemintUnavailableError(err: unknown): boolean {
  return getClientErrorCode(err) === 'runtime_unavailable'
}

function getClientErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message
  }
  if (!err || typeof err !== 'object') {
    return undefined
  }
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

async function resolveCoordinatorTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string> {
  return await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from', {
    validateEnvHandle: true
  })
}

async function resolveImplicitOrchestrationSender(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string> {
  try {
    return await getTerminalHandle(flags, cwd, client)
  } catch (err) {
    if (!isNoActiveTerminalError(err)) {
      throw err
    }
    throwNoActiveSenderTerminal()
  }
}

function throwNoActiveSenderTerminal(): never {
  throw new RuntimeClientError(
    'no_active_sender_terminal',
    'Could not determine the sender terminal for this orchestration command. ' +
      'Pass --from <terminal-handle> or run the command inside a live Orca terminal with ORCA_TERMINAL_HANDLE set.'
  )
}

function isDevCliInvocation(): boolean {
  return (
    process.env.ORCA_DEV_CLI_INVOCATION === '1' ||
    (process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') ?? false)
  )
}

function getOptionalPositiveIntegerValueFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const raw = flags.get(name)
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
  }
  const value = parsePositiveSafeIntegerText(raw)
  if (value === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid positive safe integer for --${name}: ${raw}`
    )
  }
  return value
}

function rejectLifecycleGroupRecipient(type: string | undefined, to: string): void {
  if ((type === 'worker_done' || type === 'heartbeat') && to.startsWith('@')) {
    throw new RuntimeClientError('invalid_argument', getLifecycleGroupRecipientError(type))
  }
}

// Why: only `released`/`already_released` prove the terminal is gone. `release_pending` and
// `release_unknown` leave a possibly-live worker, so automated flows must not build on them.
function isSettledRelease(state: string): boolean {
  return state === 'released' || state === 'already_released'
}

// Why: only these dispatch states prove the worker process is no longer running; `stopping`,
// `stop_unknown`, and any pre-terminal state may leave a live worker behind.
function isSettledStop(state: string): boolean {
  return ['stopped', 'succeeded', 'failed', 'abandoned'].includes(state)
}

function callMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; orchestrationCapability?: string }
) {
  const requestId = getOptionalStringFlag(flags, 'retry-request')
  if (!requestId) {
    return options
      ? client.call<TResult>(method, params, options)
      : client.call<TResult>(method, params)
  }
  return client.call<TResult>(method, params, {
    ...options,
    orchestrationRequestId: requestId
  })
}

type LegacyWorkerReadResult = {
  dispatchId: string
  terminal: RuntimeTerminalRead
}

function formatWorkerRead(value: OrchestrationWorkerReadResult | LegacyWorkerReadResult): string {
  if (!('source' in value) || value.source === 'terminal') {
    return value.terminal.tail.join('\n')
  }
  return value.transcript.messages.map(formatWorkerTranscriptMessage).join('\n\n')
}

function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  const blocks = message.blocks.map((block) => {
    if (block.type === 'text') {
      return block.text
    }
    if (block.type === 'tool-call') {
      return `[tool ${block.name}] ${safeJson(block.input)}`
    }
    if (block.type === 'tool-result') {
      return `[tool result${block.isError ? ' error' : ''}] ${block.output}`
    }
    return block.url ? `[image] ${block.url}` : `[image omitted]`
  })
  return `[${message.role}] ${blocks.join('\n')}`.trimEnd()
}

type WorkerReleaseReceipt = {
  dispatchId: string
  state: string
  reason?: string
  processAction: string
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

type WorkerShowReceipt = {
  dispatch: {
    id: string
    task_id: string
    run_id: string
    status: string
  }
  worker: {
    state: string
    stage: string
    agent_terminal_handle: string | null
    worktree_id?: string | null
    startOptions?: {
      managedAccount?: {
        provider: 'codex'
        id: string
        label?: string
      } | null
    }
  }
}

type WorkerStartReceipt = {
  runId: string
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printLocalResult(value: unknown, json: boolean, text: string): void {
  console.log(json ? JSON.stringify({ ok: true, result: value }, null, 2) : text)
}

function formatWorkerRelease(value: WorkerReleaseReceipt): string {
  const head = `Worker ${value.dispatchId} terminal [${value.state}]`
  const lines = [
    `${head}${value.reason ? ` reason=${value.reason}` : ''} process=${value.processAction}`
  ]
  if (value.archive) {
    lines.push(`archive ${value.archive.source ?? 'none'} [${value.archive.status ?? 'unknown'}]`)
  }
  if (value.lastError) {
    lines.push(value.lastError)
  }
  if (value.recovery) {
    lines.push(value.recovery)
  }
  return lines.join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable input]'
  }
}

export const ORCHESTRATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from
    })
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run ? `${r.run.id} ${r.run.objective}` : 'No Run is bound to this terminal.'
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
    }>('orchestration.runShow', { id: getRequiredStringFlag(flags, 'id') })
    printResult(
      result,
      json,
      (r) =>
        `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
        `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}`
    )
  },

  'orchestration send': async ({ flags, client, cwd, json }) => {
    const to = getOptionalStringFlag(flags, 'to')
    const type = getOptionalStringFlag(flags, 'type')
    if (to) {
      rejectLifecycleGroupRecipient(type, to)
    }
    const outcome = getOptionalStringFlag(flags, 'outcome')
    if (type !== 'worker_done' && outcome !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--outcome is only valid with --type worker_done.'
      )
    }

    if (
      (type === 'worker_done' || type === 'heartbeat') &&
      !getOptionalStringFlag(flags, 'from') &&
      !process.env.ORCA_TERMINAL_HANDLE
    ) {
      // Why: focus isn't lifecycle authority — an identity-less subprocess must fail closed rather than guess the worker.
      throwNoActiveSenderTerminal()
    }

    // Why: lifecycle senders preserve ORCA_TERMINAL_HANDLE across restarts for older runtimes.
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const sendParams = {
      from,
      to,
      run: getOptionalStringFlag(flags, 'run'),
      subject: getRequiredStringFlag(flags, 'subject'),
      body: getOptionalStringFlag(flags, 'body'),
      type,
      priority: getOptionalStringFlag(flags, 'priority'),
      threadId: getOptionalStringFlag(flags, 'thread-id'),
      payload: getOptionalStructuredMessagePayload(flags),
      // Why: pane key is the remint-stable sender identity the runtime verifies lifecycle ownership against; older runtimes strip it.
      senderPaneKey: process.env.ORCA_PANE_KEY || undefined,
      waitForLifecycleSettlement: type === 'worker_done' ? true : undefined,
      devMode: isDevCliInvocation()
    }
    const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
    const result = await callMutation<OrchestrationSendResult>(
      client,
      flags,
      'orchestration.send',
      sendParams,
      dispatchCapability ? { orchestrationCapability: dispatchCapability } : undefined
    )
    await requireWorkerDoneSettlement(client, type, sendParams.payload, result.result)
    if ('lifecycle' in result.result && result.result.lifecycle?.action === 'rejected') {
      throw new RuntimeClientError(result.result.lifecycle.code, result.result.lifecycle.reason)
    }
    printResult(result, json, (r) => {
      if ('message' in r) {
        return `Sent ${r.message.id}`
      }
      if ('relay' in r) {
        if (r.relay.destination === 'worker') {
          return `Queued ${r.relay.messageId} for worker Dispatch ${r.relay.dispatchId}`
        }
        return `Queued ${r.relay.messageId} for Run home (Dispatch ${r.relay.dispatchId})`
      }
      return `Sent ${r.messages.length} messages to ${r.recipients} recipients`
    })
  },

  'orchestration check': async ({ flags, client, cwd, json }) => {
    const wait = flags.has('wait')
    const peek = flags.has('peek')
    // Why: enforce mode exclusivity client-side — older runtimes strip unknown peek and run --unread --peek as destructive mark-read.
    if ([flags.has('unread'), peek, flags.has('all')].filter(Boolean).length > 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose at most one message read mode: --unread, --peek, or --all.'
      )
    }
    const timeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    const explicitTerminal = getOptionalStringFlag(flags, 'terminal')
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')

    // Why: Claude Code auto-backgrounds subprocesses silent ~2 min; emit JSON keepalives to stderr (stdout stays one payload). See §3.4.
    const stopKeepalive = wait ? startCheckKeepalive(timeoutMs) : null
    type CheckResult = {
      messages: MessageSummary[]
      count: number
      formatted?: string
      deliveryId?: string | null
      runId?: string
      timedOut?: boolean
      cancelled?: boolean
      connectionLost?: boolean
      legacyCompatibility?: LegacyCompatibilityResult
    }
    let result: Awaited<ReturnType<typeof client.call<CheckResult>>>
    try {
      result = await callMutation<CheckResult>(client, flags, 'orchestration.check', {
        terminal,
        terminalPaneKey: explicitTerminal ? undefined : process.env.ORCA_PANE_KEY || undefined,
        // Why: peek also sends unread:false so pre-peek runtimes degrade to non-consuming all mode instead of destructive mark-read.
        unread: flags.has('unread') ? true : peek ? false : undefined,
        peek: peek ? true : undefined,
        all: flags.has('all') ? true : undefined,
        types: getOptionalStringFlag(flags, 'types'),
        format: flags.has('format') ? true : undefined,
        inject: flags.has('inject') ? true : undefined,
        compatibilityCliCommand: resolveCompatibilityCliCommand(),
        run: getOptionalStringFlag(flags, 'run'),
        ack: getOptionalStringFlag(flags, 'ack'),
        wait: wait ? true : undefined,
        timeoutMs
      })
    } finally {
      stopKeepalive?.()
    }
    if (peek) {
      const rawRowCount = result.result.messages.length
      const unreadOnly = result.result.messages.filter((m) => m.read !== 1)
      const removedReadRows = unreadOnly.length !== rawRowCount
      // Why: read rows mean a pre-peek runtime ran the all mode and returned instead of blocking; can't honor --wait, so fail loudly.
      if (wait && removedReadRows && unreadOnly.length === 0) {
        throw new RuntimeClientError(
          'peek_wait_unsupported',
          'The connected runtime does not support --peek with --wait; upgrade the runtime or use --wait without --peek.'
        )
      }
      // Why: pre-peek runtimes cap the all mode at 100 rows; a full page may hide older unread — warn on stderr.
      if (removedReadRows && rawRowCount >= 100) {
        console.error(
          'Warning: this runtime returned only its newest 100 messages for --peek; older unread messages may be missing. Upgrade the runtime for exact peek results.'
        )
      }
      result = {
        ...result,
        result: {
          ...result.result,
          // Why: a pre-peek runtime builds `formatted` from all rows; drop it so output matches the filtered peek set.
          ...(removedReadRows ? { formatted: undefined } : {}),
          messages: unreadOnly,
          count: unreadOnly.length
        }
      }
    }
    result = {
      ...result,
      result: prepareOrchestrationCheckOutput(result.result, terminal, flags.has('format'))
    }
    printResult(result, json, (r) => formatOrchestrationCheckText(r, terminal))
    const compatibilityAck = result.result.legacyCompatibility?.ackMessageIds
    if (compatibilityAck && compatibilityAck.length > 0) {
      await flushStdout()
      await client.call('orchestration.check', {
        terminal,
        compatibilityAck: JSON.stringify({
          messageIds: compatibilityAck,
          types: getOptionalStringFlag(flags, 'types')
            ?.split(',')
            .map((type) => type.trim())
            .filter(Boolean)
        })
      })
    }
  },

  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callMutation<{ message: { id: string } }>(
      client,
      flags,
      'orchestration.reply',
      {
        id: getRequiredStringFlag(flags, 'id'),
        body: getRequiredStringFlag(flags, 'body'),
        run: getOptionalStringFlag(flags, 'run'),
        from
      }
    )
    printResult(result, json, (r) => `Replied ${r.message.id}`)
  },

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getOptionalStringFlag(flags, 'terminal')
    })
    printResult(result, json, (r) => {
      if (r.count === 0) {
        return 'No messages.'
      }
      // Why: default output omits body/payload for at-a-glance sweeps; --full prints them for auditing.
      return r.messages
        .map((m) => {
          const head = `${m.id}${formatMessageReadOnlyTag(m)} ${m.from_handle} -> ${m.to_handle ?? '?'}: "${m.subject}"`
          if (!full) {
            return head
          }
          const parts = [head]
          if (m.body && m.body.length > 0) {
            parts.push(m.body)
          }
          if (m.payload) {
            parts.push(`[payload] ${m.payload}`)
          }
          return parts.join('\n')
        })
        .join(full ? '\n\n' : '\n')
    })
  },

  'orchestration task-create': async ({ flags, client, cwd, json }) => {
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callMutation<{ task: { id: string; status: string } }>(
      client,
      flags,
      'orchestration.taskCreate',
      {
        spec: getRequiredStringFlag(flags, 'spec'),
        taskTitle: getOptionalStringFlag(flags, 'task-title'),
        displayName: getOptionalStringFlag(flags, 'display-name'),
        deps: getOptionalStringFlag(flags, 'deps'),
        parent: getOptionalStringFlag(flags, 'parent'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle
      }
    )
    printResult(result, json, (r) => `Created ${r.task.id} [${r.task.status}]`)
  },

  'orchestration task-list': async ({ flags, client, cwd, json }) => {
    const brief = flags.has('brief')
    const run = getOptionalStringFlag(flags, 'run')
    const callerTerminalHandle = run
      ? undefined
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      tasks: {
        id: string
        spec: string
        task_title?: string | null
        display_name?: string | null
        status: string
        assignee_handle?: string | null
        dispatch_id?: string | null
        spec_truncated?: boolean
      }[]
      count: number
      runId?: string
      legacyReadOnly?: boolean
    }>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined,
      brief: brief ? true : undefined,
      run,
      callerTerminalHandle
    })
    // Why: only older runtimes (no spec_truncated) skip server-side abbreviation and need this client-side fallback.
    const needsClientAbbreviation =
      brief && result.result.tasks.some((task) => task.spec_truncated === undefined)
    const output = needsClientAbbreviation
      ? {
          ...result,
          result: {
            ...result.result,
            tasks: abbreviateOrchestrationTasks(result.result.tasks)
          }
        }
      : result
    printResult(output, json, (r) => {
      if (r.count === 0) {
        return r.legacyReadOnly ? 'No legacy tasks (read-only).' : 'No tasks.'
      }
      const tasks = r.tasks
        .map((t) => {
          const label = t.display_name ?? t.task_title ?? t.spec
          const head = `${t.id} [${t.status}] ${label.slice(0, 60)}`
          if (t.status === 'dispatched' && t.assignee_handle) {
            return `${head} -> ${t.assignee_handle} (${t.dispatch_id ?? '?'})`
          }
          return head
        })
        .join('\n')
      return r.legacyReadOnly ? `Legacy Run ${r.runId} (read-only)\n${tasks}` : tasks
    })
  },

  'orchestration task-update': async ({ flags, client, cwd, json }) => {
    const status = getRequiredStringFlag(flags, 'status')
    if (!TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid status '${status}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
      )
    }
    const result = await callMutation<{ task: { id: string; status: string } }>(
      client,
      flags,
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status,
        result: getOptionalStringFlag(flags, 'result'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printResult(result, json, (r) => `Updated ${r.task.id} -> ${r.task.status}`)
  },

  'orchestration worker-start': async ({ flags, client, cwd, json }) => {
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    if (model || effort) {
      const status = await client.call<RuntimeStatus>('status.get')
      if (
        !status.result.capabilities?.includes(
          ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
        )
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support worker model or effort overrides. Update or restart Orca and try again.'
        )
      }
    }
    const result = await callMutation<{
      runId: string
      taskId: string
      dispatchId: string
      state: string
      failedStage?: string
      lastError?: string
      warning?: string
      effects: unknown[]
      residualResources: unknown[]
    }>(client, flags, 'orchestration.workerStart', {
      task: getRequiredStringFlag(flags, 'task'),
      on: getOptionalStringFlag(flags, 'on'),
      worktree: getOptionalStringFlag(flags, 'worktree'),
      name: getOptionalStringFlag(flags, 'name'),
      repo: getOptionalStringFlag(flags, 'repo'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      comment: getOptionalStringFlag(flags, 'comment'),
      setup: getOptionalStringFlag(flags, 'setup'),
      agent: getOptionalStringFlag(flags, 'agent'),
      model,
      effort,
      terminal: getOptionalStringFlag(flags, 'terminal'),
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      devMode: isDevCliInvocation()
    })
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    printResult(result, json, (worker) => {
      const base = `Worker ${worker.dispatchId} [${worker.state}] for ${worker.taskId}`
      if (worker.lastError) {
        return `${base}\n${worker.failedStage ?? 'start'}: ${worker.lastError}`
      }
      return worker.warning ? `${base}\nWarning: ${worker.warning}` : base
    })
  },

  'orchestration worker-supervise': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const task = getRequiredStringFlag(flags, 'task')
    if (getOptionalStringFlag(flags, 'on')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'worker-supervise selects a managed account on the local Orca runtime and cannot use --on. Run it on the worker server instead.'
      )
    }
    const accountsSnapshot = await client.call<{
      codex: CodexRateLimitAccountsState
    }>('accounts.list', { refreshUsage: false })
    let selectors: string[]
    try {
      selectors = parseAccountOrder(
        getOptionalStringFlag(flags, 'accounts'),
        accountsSnapshot.result.codex.accounts
      )
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error)
      )
    }
    const accounts = selectors.map((selector) => {
      try {
        return resolveCodexAccount(accountsSnapshot.result.codex.accounts, selector)
      } catch (error) {
        throw new RuntimeClientError(
          'invalid_argument',
          error instanceof Error ? error.message : String(error)
        )
      }
    })
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
      throw new RuntimeClientError('invalid_argument', '--accounts resolves to duplicate accounts.')
    }

    // Why: worker-supervise always sends managedAccount (and may send model/effort). A runtime
    // without these capabilities strips the fields silently via non-strict schema parsing, so the
    // acceptance receipt would record null instead of the account that actually ran. Refuse early.
    const runtimeStatus = await client.call<RuntimeStatus>('status.get')
    const runtimeCapabilities = runtimeStatus.result.capabilities ?? []
    if (!runtimeCapabilities.includes(ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The connected Orca runtime does not record managed-account identity on worker starts, so supervised account failover cannot leave a truthful audit trail. Update or restart Orca and try again.'
      )
    }
    if (
      (getOptionalStringFlag(flags, 'model') || getOptionalStringFlag(flags, 'effort')) &&
      !runtimeCapabilities.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The connected Orca runtime does not support worker model or effort overrides. Update or restart Orca and try again.'
      )
    }

    const pollMs = getOptionalPositiveIntegerValueFlag(flags, 'poll-ms') ?? 2_000
    const waitTimeoutMs =
      getOptionalPositiveIntegerValueFlag(flags, 'wait-timeout-ms') ?? 6 * 60 * 60 * 1_000
    const deadline = Date.now() + waitTimeoutMs
    const attempts: {
      accountId: string
      accountLabel: string | null
      dispatchId: string | null
      // Why: printed durably so a lost start response can be recovered exactly by rerunning the
      // same worker-supervise with --retry-start-request <startRequestId> — identical payload,
      // same ledger receipt, no second Dispatch.
      startRequestId: string
      state: string
      reason?: string
    }[] = []
    // Why: recovery of a lost reply on attempt N must replay the exact original payload — same
    // account, same retryOf lineage, same mutation id — so the printed recovery command carries
    // all three and this initializer restores the lineage.
    let retryOf: string | undefined = getOptionalStringFlag(flags, 'retry-start-retry-of')

    for (const [accountIndex, account] of accounts.entries()) {
      if (Date.now() >= deadline) {
        process.exitCode = 1
        printLocalResult(
          { state: 'timed_out_between_attempts', attempts },
          json,
          'Supervision timed out after releasing the previous attempt; no additional account was selected and no new worker was started.'
        )
        return
      }
      const selected = await client.call<CodexRateLimitAccountsState>('accounts.selectCodex', {
        accountId: account.id
      })
      const activeAccountId =
        selected.result.activeAccountIdsByRuntime?.host ?? selected.result.activeAccountId
      if (activeAccountId !== account.id) {
        // Why: print the durable attempt history before failing, so earlier account evidence
        // survives even when the runtime cannot confirm this selection.
        process.exitCode = 1
        printLocalResult(
          {
            state: 'account_select_unconfirmed',
            accountId: account.id,
            attempts
          },
          json,
          `Orca did not confirm Codex account ${account.id} as active; no worker was started and supervision stopped.`
        )
        return
      }
      // Why: a per-attempt mutation id lets the executor deduplicate transport-level retries of
      // this start instead of silently spawning a second dispatch. --retry-start-request replays
      // the first attempt with the exact original id (and identical payload) after a lost reply.
      const startRequestId =
        (attempts.length === 0 ? getOptionalStringFlag(flags, 'retry-start-request') : undefined) ??
        `worker-supervise-${randomUUID()}`
      const attempt = {
        accountId: account.id,
        accountLabel: account.workspaceLabel ?? null,
        dispatchId: null as string | null,
        startRequestId,
        state: 'starting'
      } as (typeof attempts)[number]
      attempts.push(attempt)
      let started: Awaited<ReturnType<typeof client.call<WorkerStartReceipt>>>
      try {
        started = await client.call<WorkerStartReceipt>(
          'orchestration.workerStart',
          {
            task,
            on: getOptionalStringFlag(flags, 'on'),
            worktree: getOptionalStringFlag(flags, 'worktree'),
            name: getOptionalStringFlag(flags, 'name'),
            repo: getOptionalStringFlag(flags, 'repo'),
            baseBranch: getOptionalStringFlag(flags, 'base-branch'),
            displayName: getOptionalStringFlag(flags, 'display-name'),
            comment: getOptionalStringFlag(flags, 'comment'),
            setup: getOptionalStringFlag(flags, 'setup'),
            agent: 'codex',
            managedAccount: {
              provider: 'codex',
              id: account.id,
              label: account.workspaceLabel ?? account.email
            },
            model: getOptionalStringFlag(flags, 'model'),
            effort: getOptionalStringFlag(flags, 'effort'),
            retryOf,
            timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
            run: getOptionalStringFlag(flags, 'run'),
            from,
            devMode: isDevCliInvocation()
          },
          { orchestrationRequestId: startRequestId }
        )
      } catch (error) {
        // Why: classification follows the error's PROVENANCE, not its code. RuntimeRpcFailureError
        // wraps a structured server response — the server definitely answered, whatever the code
        // says — so it must never be replayed blindly. Any other failure (transport-minted
        // RuntimeClientError, socket errors, …) means the outcome is unknown and the
        // byte-identical replay is safe.
        if (error instanceof RuntimeRpcFailureError) {
          attempt.state = 'start_failed'
          attempt.reason = `${error.code}: ${error.message}`
          process.exitCode = 1
          printLocalResult(
            { state: 'start_failed', errorCode: error.code, attempts },
            json,
            `The runtime rejected the start for account ${account.id} (${error.code}); follow the error's own guidance instead of replaying the same request id. ${error.message}`
          )
          return
        }
        // Why: the attempt (with its exact request id, account, and retryOf lineage) must survive
        // in durable output so recovery can replay the byte-identical mutation.
        attempt.state = 'start_outcome_unknown'
        attempt.reason = error instanceof Error ? error.message : String(error)
        process.exitCode = 1
        const remainingSelectors = selectors.slice(accountIndex).join(',')
        // Why: a paired remote session cannot be reconstructed from durable output without leaking
        // the pairing secret, and a recovery that silently reconnects to the default local runtime
        // would replay against the wrong ledger. Refuse to compose a command instead.
        if (getOptionalStringFlag(flags, 'pairing-code')) {
          printLocalResult(
            { state: 'start_outcome_unknown', attempts },
            json,
            `The start for account ${account.id} did not return a receipt. This session used --pairing-code, which cannot be written into a durable recovery command; rerun the identical worker-supervise yourself (same pairing, same flags) adding --retry-start-request ${startRequestId}${retryOf ? ` --retry-start-retry-of ${retryOf}` : ''} and --accounts "${remainingSelectors}".`
          )
          return
        }
        // Why: the ledger hashes method + full params, so the replay must round-trip every
        // originally-provided flag (plus the resolved coordinator handle and runtime identity) —
        // dropping any of them would change the payload or the target ledger.
        const passthroughFlags = [
          'worktree',
          'name',
          'repo',
          'base-branch',
          'display-name',
          'comment',
          'setup',
          'model',
          'effort',
          'timeout-ms',
          'wait-timeout-ms',
          'poll-ms',
          'run',
          'environment'
        ]
        const recoveryArgs = ['orchestration', 'worker-supervise', '--task', task]
        recoveryArgs.push('--accounts', remainingSelectors)
        for (const flag of passthroughFlags) {
          const value = getOptionalStringFlag(flags, flag)
          if (value !== undefined) {
            recoveryArgs.push(`--${flag}`, value)
          }
        }
        recoveryArgs.push('--from', from, '--retry-start-request', startRequestId)
        if (retryOf) {
          recoveryArgs.push('--retry-start-retry-of', retryOf)
        }
        recoveryArgs.push('--json')
        const recoveryCommand = `orca ${recoveryArgs.map(posixShellQuote).join(' ')}`
        printLocalResult(
          { state: 'start_outcome_unknown', recoveryCommand, recoveryArgs, attempts },
          json,
          `The start for account ${account.id} did not return a receipt. Recover the exact same start (same account, lineage, request id, and runtime — no second Dispatch) with:\n${recoveryCommand}`
        )
        return
      }
      attempt.dispatchId = started.result.dispatchId
      attempt.state = started.result.state
      if (started.result.lastError) {
        attempt.reason = started.result.lastError
      }
      if (started.result.state !== 'ready') {
        if (started.result.lastError && isCodexQuotaExhaustedText(started.result.lastError)) {
          attempt.state = 'quota_exhausted'
          attempt.reason = 'provider_usage_limit'
          const released = await client.call<WorkerReleaseReceipt>('orchestration.workerRelease', {
            dispatch: started.result.dispatchId
          })
          if (!isSettledRelease(released.result.state)) {
            process.exitCode = 1
            printLocalResult(
              {
                state: 'release_unsettled',
                release: released.result,
                attempts
              },
              json,
              `Worker ${started.result.dispatchId} could not be provably released (${released.result.state}); supervision stopped before starting another account.`
            )
            return
          }
          retryOf = started.result.dispatchId
          continue
        }
        attempt.state = 'start_failed'
        process.exitCode = 1
        printLocalResult(
          { state: 'start_failed', attempts },
          json,
          `Worker ${started.result.dispatchId} failed to start without provider quota evidence; automatic account switching stopped.`
        )
        return
      }

      // Why: account identity is proven runtime-side — workerStart consults the PTY launch-account
      // registry (immune to select→start ABA races) and fails the start whenever the requested
      // managed account cannot be proven, so a non-ready receipt above already covers mismatch.
      while (Date.now() < deadline) {
        const [output, inbox, show] = await Promise.all([
          client.call<OrchestrationWorkerReadResult>('orchestration.workerRead', {
            dispatch: started.result.dispatchId,
            source: 'auto',
            limit: 100
          }),
          // Why: `all` returns the full mailbox history without consuming it. The peek/unread pair
          // only surfaces UNREAD messages, so a worker_done already read by any other consumer
          // (another supervise, a manual `check`) would never be seen and supervise would spin to
          // its timeout. The managed-account capability gate above guarantees a runtime that
          // understands `all`.
          client.call<OrchestrationCheckOutput>('orchestration.check', {
            terminal: from,
            run: started.result.runId,
            all: true,
            types: 'worker_done,escalation,question'
          }),
          client.call<WorkerShowReceipt>('orchestration.workerShow', {
            dispatch: started.result.dispatchId
          })
        ])
        const lifecycle = lifecycleMessageForDispatch(
          inbox.result.messages,
          started.result.dispatchId
        )
        if (lifecycle) {
          const payload = lifecycle.payload ? JSON.parse(lifecycle.payload) : {}
          if (lifecycle.type === 'worker_done' && payload.outcome === 'succeeded') {
            attempt.state = 'awaiting_acceptance'
            const result = {
              state: 'awaiting_acceptance',
              runId: started.result.runId,
              taskId: started.result.taskId,
              dispatchId: started.result.dispatchId,
              account: {
                id: account.id,
                email: account.email,
                workspaceLabel: account.workspaceLabel ?? null
              },
              message: lifecycle,
              attempts,
              nextCommand: `orca orchestration worker-accept --dispatch ${started.result.dispatchId} --evidence <review-evidence> --json`
            }
            printLocalResult(
              result,
              json,
              `Worker ${started.result.dispatchId} completed with ${account.workspaceLabel ?? account.email}; awaiting coordinator acceptance.\n${result.nextCommand}`
            )
            return
          }
          attempt.state = lifecycle.type === 'worker_done' ? 'failed' : 'needs_attention'
          process.exitCode = lifecycle.type === 'worker_done' ? 1 : 2
          printLocalResult(
            { state: attempt.state, message: lifecycle, attempts },
            json,
            `Worker ${started.result.dispatchId} requires coordinator attention: ${lifecycle.type} ${lifecycle.subject ?? ''}`
          )
          return
        }

        if (isCodexQuotaExhaustedRead(output.result)) {
          attempt.state = 'quota_exhausted'
          attempt.reason = 'provider_usage_limit'
          // Why: the next attempt may reuse the same worktree, so a worker that cannot be proven
          // stopped AND released must halt supervision — two workers writing one tree is worse
          // than a manual follow-up.
          const stopped = await client.call<{ state: string }>('orchestration.workerStop', {
            dispatch: started.result.dispatchId
          })
          if (!isSettledStop(stopped.result.state)) {
            process.exitCode = 1
            printLocalResult(
              { state: 'stop_unsettled', stop: stopped.result, attempts },
              json,
              `Worker ${started.result.dispatchId} could not be provably stopped after quota exhaustion; supervision stopped before starting another account.`
            )
            return
          }
          const released = await client.call<WorkerReleaseReceipt>('orchestration.workerRelease', {
            dispatch: started.result.dispatchId
          })
          if (!isSettledRelease(released.result.state)) {
            process.exitCode = 1
            printLocalResult(
              {
                state: 'release_unsettled',
                release: released.result,
                attempts
              },
              json,
              `Worker ${started.result.dispatchId} could not be provably released (${released.result.state}); supervision stopped before starting another account.`
            )
            return
          }
          retryOf = started.result.dispatchId
          break
        }

        if (show.result.dispatch.status === 'failed' || show.result.worker.state === 'failed') {
          attempt.state = 'failed'
          attempt.reason = 'worker_failed_without_quota_evidence'
          process.exitCode = 1
          printLocalResult(
            { state: 'failed', attempts },
            json,
            `Worker ${started.result.dispatchId} failed without provider quota evidence; automatic account switching stopped.`
          )
          return
        }
        // Why: cap the nap at the remaining budget so the overall deadline cannot overshoot by a
        // full poll interval.
        await sleep(boundedPollDelayMs(pollMs, deadline, Date.now()))
      }
      if (attempt.state === 'quota_exhausted') {
        continue
      }
      if (Date.now() >= deadline) {
        attempt.state = 'timed_out'
        process.exitCode = 1
        printLocalResult(
          { state: 'timed_out', attempts },
          json,
          `Supervision timed out while waiting for ${started.result.dispatchId}; the worker was retained for inspection.`
        )
        return
      }
    }

    process.exitCode = 1
    printLocalResult(
      { state: 'accounts_exhausted', attempts },
      json,
      `All ${accounts.length} configured Codex accounts reported provider quota exhaustion. No unlisted account was used.`
    )
  },

  'orchestration worker-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string }
      worker: {
        state: string
        stage: string
        agent_terminal_handle: string | null
      }
    }>('orchestration.workerShow', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(
      result,
      json,
      (value) =>
        `${value.dispatch.id} task=${value.dispatch.task_id} [${value.worker.state}] stage=${value.worker.stage}`
    )
  },

  'orchestration worker-read': async ({ flags, client, json }) => {
    const cursorFlag = getOptionalStringFlag(flags, 'cursor')
    const cursor =
      cursorFlag !== undefined && /^\d+$/.test(cursorFlag)
        ? Number.parseInt(cursorFlag, 10)
        : cursorFlag
    const source = getOptionalStringFlag(flags, 'source')
    if (source && !['auto', 'transcript', 'terminal'].includes(source)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--source must be auto, transcript, or terminal'
      )
    }
    const result = await client.call<OrchestrationWorkerReadResult | LegacyWorkerReadResult>(
      'orchestration.workerRead',
      {
        dispatch: getRequiredStringFlag(flags, 'dispatch'),
        cursor,
        limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
        source: source as OrchestrationWorkerReadSource | undefined
      }
    )
    printResult(result, json, formatWorkerRead)
  },

  'orchestration worker-stop': async ({ flags, client, json }) => {
    const result = await callMutation<{
      dispatchId: string
      state: string
      processAction: string
      lastError?: string
      warning?: string
    }>(client, flags, 'orchestration.workerStop', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    if (result.result.state === 'stop_unknown') {
      process.exitCode = 1
    }
    printResult(
      result,
      json,
      (value) =>
        `Worker ${value.dispatchId} [${value.state}] process=${value.processAction}${value.lastError ? `\n${value.lastError}` : ''}${value.warning ? `\nWarning: ${value.warning}` : ''}`
    )
  },

  'orchestration worker-abandon': async ({ flags, client, json }) => {
    const result = await callMutation<{
      dispatchId: string
      state: string
      warning: string
    }>(client, flags, 'orchestration.workerAbandon', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(
      result,
      json,
      (value) => `Worker ${value.dispatchId} [${value.state}]\nWarning: ${value.warning}`
    )
  },

  'orchestration worker-release': async ({ flags, client, json }) => {
    const result = await callMutation<WorkerReleaseReceipt>(
      client,
      flags,
      'orchestration.workerRelease',
      { dispatch: getRequiredStringFlag(flags, 'dispatch') }
    )
    // Why: retained/already_released are settled answers; release_pending and release_unknown
    // both leave a recovery obligation, so they must not exit 0 as if the terminal were gone.
    if (result.result.state === 'release_unknown' || result.result.state === 'release_pending') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-accept': async ({ flags, client, cwd, json }) => {
    const dispatchId = getRequiredStringFlag(flags, 'dispatch')
    const evidence = getRequiredStringFlag(flags, 'evidence')
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const shown = await client.call<WorkerShowReceipt>('orchestration.workerShow', {
      dispatch: dispatchId
    })
    if (shown.result.dispatch.status !== 'completed' || shown.result.worker.state !== 'succeeded') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Worker ${dispatchId} is not a succeeded worker_done settlement; current dispatch=${shown.result.dispatch.status}, worker=${shown.result.worker.state}.`
      )
    }

    let worktreeCloseable = false
    let worktreeReason = 'worker has no exact worktree identity'
    let worktreeSha: string | null = null
    if (shown.result.worker.worktree_id) {
      const status = await client.call<GitStatusResult>('git.status', {
        worktree: `id:${shown.result.worker.worktree_id}`
      })
      const closure = evaluateWorktreeClosure(status.result)
      worktreeCloseable = closure.closeable
      worktreeReason = closure.reason
      worktreeSha = status.result.head ?? null
    }

    const payload = buildAcceptancePayload({
      taskId: shown.result.dispatch.task_id,
      dispatchId,
      evidence,
      accountId: shown.result.worker.startOptions?.managedAccount?.id,
      accountLabel: shown.result.worker.startOptions?.managedAccount?.label,
      worktreeCloseable,
      worktreeReason,
      worktreeSha
    })
    // Why: the acceptance send is idempotent by construction — its mutation id is derived from the
    // dispatch, so every invocation (first run or crash-recovery rerun) hits the same ledger
    // receipt instead of writing a duplicate. A rerun with different evidence or a changed
    // worktree state fails closed as request_mismatch rather than silently rewriting history.
    const acceptanceSendRequestId = `worker-accept-acceptance-${dispatchId}`
    const retryReleaseRequest =
      getOptionalStringFlag(flags, 'retry-release-request') ??
      // Legacy alias: --retry-request predates the two-phase flags and always meant the release.
      getOptionalStringFlag(flags, 'retry-request')
    const acceptance = await client.call<OrchestrationSendResult>(
      'orchestration.send',
      {
        from,
        to: `dispatch:${dispatchId}`,
        run: shown.result.dispatch.run_id,
        subject: 'Coordinator accepted worker result',
        body:
          `The coordinator accepted and took ownership of the result. ` +
          `${worktreeCloseable ? 'The clean worktree may be closed by the coordinator.' : `The worktree remains retained: ${worktreeReason}.`}`,
        type: 'status',
        priority: 'normal',
        payload
      },
      { orchestrationRequestId: acceptanceSendRequestId }
    )
    const release = await client.call<WorkerReleaseReceipt>(
      'orchestration.workerRelease',
      { dispatch: dispatchId },
      retryReleaseRequest ? { orchestrationRequestId: retryReleaseRequest } : undefined
    )
    // Why: only a settled release means the terminal is provably gone. `release_pending` keeps a
    // recovery obligation, so reporting it as accepted/exit 0 would false-green the closure loop.
    if (!isSettledRelease(release.result.state)) {
      process.exitCode = 1
    }
    const result = {
      state: isSettledRelease(release.result.state)
        ? 'accepted'
        : `acceptance_recorded_release_${release.result.state === 'release_unknown' ? 'unknown' : 'pending'}`,
      dispatchId,
      taskId: shown.result.dispatch.task_id,
      evidence,
      acceptance,
      terminal: release.result,
      worktree: {
        id: shown.result.worker.worktree_id ?? null,
        closeable: worktreeCloseable,
        reason: worktreeReason,
        sha: worktreeSha,
        removed: false
      }
    }
    printLocalResult(
      result,
      json,
      `Accepted ${dispatchId}; terminal=${release.result.state}; worktree=${worktreeCloseable ? 'closeable' : 'retained'} (${worktreeReason}).`
    )
  },

  'orchestration worker-retain': async ({ flags, client, json }) => {
    const result = await callMutation<WorkerReleaseReceipt>(
      client,
      flags,
      'orchestration.workerRetain',
      { dispatch: getRequiredStringFlag(flags, 'dispatch') }
    )
    // Why: an already-committed close can surface as release_pending here too; both unsettled
    // states leave a recovery obligation and must not exit 0.
    if (result.result.state === 'release_unknown' || result.result.state === 'release_pending') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-list': async ({ flags, client, json }) => {
    const terminalState = getOptionalStringFlag(flags, 'terminal-state')
    if (
      terminalState &&
      !WORKER_TERMINAL_LIST_STATES.includes(
        terminalState as (typeof WORKER_TERMINAL_LIST_STATES)[number]
      )
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid --terminal-state '${terminalState}', expected one of: ${WORKER_TERMINAL_LIST_STATES.join(', ')}`
      )
    }
    const result = await client.call<{
      workers: {
        dispatchId: string
        taskId: string
        runId: string
        workerState: string
        dispatchStatus: string
        agentTerminalHandle: string | null
        terminalState: string | null
        resource: unknown
      }[]
      counts: Record<string, number>
    }>('orchestration.workerList', {
      run: getOptionalStringFlag(flags, 'run'),
      terminalState
    })
    printResult(result, json, (r) => {
      if (r.workers.length === 0) {
        return 'No workers found.'
      }
      const rows = r.workers
        .map(
          (w) =>
            `${w.dispatchId} task=${w.taskId} [${w.workerState}] terminal=${w.terminalState ?? 'none'}`
        )
        .join('\n')
      const counts = Object.entries(r.counts)
        .map(([state, count]) => `${state}=${count}`)
        .join(' ')
      return counts ? `${rows}\nTerminals: ${counts}` : rows
    })
  },

  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const dryRun = flags.has('dry-run') ? true : undefined
    const returnPreamble = flags.has('return-preamble') ? true : undefined
    // Why: --to is only required for non-dry-run; the RPC handler re-enforces.
    const to = dryRun ? getOptionalStringFlag(flags, 'to') : getRequiredStringFlag(flags, 'to')
    const result = await callMutation<{
      dispatch: { id: string; task_id: string; status: string } | null
      injected?: boolean
      dryRun?: boolean
      preamble?: string
    }>(client, flags, 'orchestration.dispatch', {
      task: getRequiredStringFlag(flags, 'task'),
      run: getOptionalStringFlag(flags, 'run'),
      to,
      from,
      inject: flags.has('inject') ? true : undefined,
      dryRun,
      returnPreamble,
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (r) => {
      if (r.dryRun) {
        return r.preamble ?? ''
      }
      const base = `Dispatched ${r.dispatch?.task_id} -> ${r.dispatch?.id} [${r.dispatch?.status}]`
      return r.preamble ? `${base}\n\n--- Preamble ---\n${r.preamble}` : base
    })
  },

  'orchestration ask': async ({ flags, client, cwd, json }) => {
    const parsedTimeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    const timeoutMs = clampOrchestrationAskTimeoutMs(parsedTimeoutMs)
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const question = getOptionalStringFlag(flags, 'question')
    const resume = getOptionalStringFlag(flags, 'resume')
    if ((question ? 1 : 0) + (resume ? 1 : 0) !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose exactly one of --question or --resume.'
      )
    }
    if (resume && flags.has('options')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--options is only valid when creating a new question.'
      )
    }
    const result = await callMutation<{
      answer: string | null
      messageId: string | null
      threadId: string
      timedOut: boolean
      timeoutMs?: number
      cancelled?: boolean
      connectionLost?: boolean
      answerMessageId?: string | null
      legacyCompatibility?: LegacyCompatibilityResult
    }>(
      client,
      flags,
      'orchestration.ask',
      {
        to: getOptionalStringFlag(flags, 'to'),
        run: getOptionalStringFlag(flags, 'run'),
        question,
        resume,
        options: getOptionalStringFlag(flags, 'options'),
        timeoutMs: parsedTimeoutMs === undefined ? undefined : timeoutMs,
        from,
        compatibilityCliCommand: resolveCompatibilityCliCommand(),
        compatibilityWindowsCommand: resolvePackagedWindowsCompatibilityCommand()
      },
      // Why: extend past timeoutMs so the RPC transport's 60s default doesn't abort before the runtime's own timeout resolves.
      {
        timeoutMs: resolveOrchestrationAskClientTimeoutMs(parsedTimeoutMs),
        orchestrationCapability: getOptionalStringFlag(flags, 'dispatch-capability')
      }
    )
    // Why: bypass printResult so --json emits a bare JSON object (no envelope) pipeable via `jq -r .answer`, unlike other verbs.
    if (json) {
      console.log(JSON.stringify(result.result))
    } else if (result.result.legacyCompatibility?.resumeRequired) {
      console.log(`Question ${result.result.messageId} committed.`)
      console.log(`Resume with: ${result.result.legacyCompatibility.resumeCommand}`)
    } else if (result.result.answer !== null) {
      console.log(result.result.answer)
    }
    if (result.result.legacyCompatibility?.resumeRequired) {
      await flushStdout()
      process.exitCode = 75
      return
    }
    const answerAck = result.result.legacyCompatibility?.answerAcknowledgement
    if (answerAck && result.result.answer !== null) {
      await flushStdout()
      await client.call('orchestration.check', {
        terminal: from,
        compatibilityQuestionAck: JSON.stringify(answerAck)
      })
    }
    if (result.result.timedOut) {
      if (!json) {
        // Why: report the server's effective budget — it clamps large values, so the requested one would overstate the wait.
        const waitedMs = result.result.timeoutMs ?? timeoutMs
        console.error(`ask timeout after ${waitedMs}ms (thread ${result.result.threadId})`)
      }
      process.exitCode = 1
    }
    if (result.result.cancelled) {
      if (!json) {
        console.error(
          result.result.connectionLost
            ? `ask connection closed (question ${result.result.messageId})`
            : `ask cancelled (question ${result.result.messageId})`
        )
      }
      process.exitCode = 1
    }
  },

  'orchestration dispatch-show': async ({ flags, client, cwd, json }) => {
    const showPreamble = flags.has('preamble') ? true : undefined
    // Why: resolve --from so the previewed preamble embeds a real coordinator handle like an actual dispatch.
    const from = showPreamble
      ? await resolveCoordinatorTerminalHandle(flags, cwd, client)
      : undefined
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
      preamble?: string
    }>('orchestration.dispatchShow', {
      task: getRequiredStringFlag(flags, 'task'),
      preamble: showPreamble,
      from,
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (r) => {
      if (r.preamble && showPreamble) {
        return r.preamble
      }
      if (!r.dispatch) {
        return 'No dispatch context found.'
      }
      return `${r.dispatch.id} task=${r.dispatch.task_id} [${r.dispatch.status}]`
    })
  },

  'orchestration coordinator-start': async () => {
    throw new RuntimeClientError(
      'orchestration_migration_required',
      'The legacy automatic coordinator command is retired. No effects were applied.',
      orchestrationMigrationData('command_retired')
    )
  },

  'orchestration coordinator-stop': async () => {
    throw new RuntimeClientError(
      'orchestration_migration_required',
      'The legacy automatic coordinator command is retired. No effects were applied.',
      orchestrationMigrationData('command_retired')
    )
  },

  'orchestration gate-create': async ({ flags, client, cwd, json }) => {
    const result = await callMutation<{
      gate: { id: string; task_id: string; status: string }
    }>(client, flags, 'orchestration.gateCreate', {
      task: getRequiredStringFlag(flags, 'task'),
      question: getRequiredStringFlag(flags, 'question'),
      options: getOptionalStringFlag(flags, 'options'),
      // Why: gates are Run-scoped, so the coordinator handle is the caller identity the runtime authorizes against.
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printResult(
      result,
      json,
      (r) => `Gate ${r.gate.id} created for task ${r.gate.task_id} [${r.gate.status}]`
    )
  },

  'orchestration gate-resolve': async ({ flags, client, cwd, json }) => {
    const result = await callMutation<{
      gate: { id: string; task_id: string; status: string; resolution: string }
    }>(client, flags, 'orchestration.gateResolve', {
      id: getRequiredStringFlag(flags, 'id'),
      resolution: getRequiredStringFlag(flags, 'resolution'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, (r) => `Gate ${r.gate.id} resolved: ${r.gate.resolution}`)
  },

  'orchestration gate-list': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    // Why: named runs remain inspectable without a pane; only implicit runs resolve identity.
    const from = run ? undefined : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      gates: {
        id: string
        task_id: string
        question: string
        status: string
      }[]
      count: number
      runId?: string
    }>('orchestration.gateList', {
      task: getOptionalStringFlag(flags, 'task'),
      status: getOptionalStringFlag(flags, 'status'),
      run,
      from
    })
    printResult(result, json, (r) => {
      if (r.gates.length === 0) {
        return 'No gates found.'
      }
      return r.gates
        .map((g) => `${g.id} task=${g.task_id} [${g.status}] "${g.question}"`)
        .join('\n')
    })
  },

  'orchestration reset': async ({ flags, client, json }) => {
    const scopeCount = [flags.has('all'), flags.has('tasks'), flags.has('messages')].filter(
      Boolean
    ).length
    if (scopeCount !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose exactly one reset scope: --all, --tasks, or --messages.'
      )
    }
    const result = await callMutation<{ reset: string }>(client, flags, 'orchestration.reset', {
      all: flags.has('all') ? true : undefined,
      tasks: flags.has('tasks') ? true : undefined,
      messages: flags.has('messages') ? true : undefined
    })
    printResult(result, json, (r) => `Reset: ${r.reset}`)
  }
}

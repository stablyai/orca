/* eslint-disable max-lines -- Why: orchestration CLI handlers share flag-parsing helpers and dispatch/preamble logic; splitting by verb would fragment the RuntimeClient call shape without reducing complexity. */
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getTerminalHandle } from '../selectors'
import { abbreviateOrchestrationTasks } from '../../shared/orchestration-task-summary'

// Why: 15 s is well under Claude Code's ~2 min Bash-tool silence budget while keeping log volume low. See design doc §3.4.
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000
function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages must be sent to a concrete coordinator terminal handle, not a group address.`
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

type MessageSummary = {
  id: string
  from_handle: string
  to_handle?: string
  subject: string
  type?: string
  body?: string
  payload?: string | null
  read?: number
}

type LifecycleSendRejection = {
  action: 'rejected'
  code: string
  reason: string
}

type OrchestrationSendResult =
  | { message: { id: string }; lifecycle?: LifecycleSendRejection }
  | { messages: { id: string }[]; recipients: number }

function getOptionalStructuredMessagePayload(
  flags: Map<string, string | boolean>
): string | undefined {
  const rawPayload = getOptionalStringFlag(flags, 'payload')
  const taskId = getOptionalStringFlag(flags, 'task-id')
  const dispatchId = getOptionalStringFlag(flags, 'dispatch-id')
  const filesModified = getOptionalStringFlag(flags, 'files-modified')
  const reportPath = getOptionalStringFlag(flags, 'report-path')
  const phase = getOptionalStringFlag(flags, 'phase')
  const hasStructuredPayload =
    taskId !== undefined ||
    dispatchId !== undefined ||
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

async function resolveTaskCreatorTerminalHandle(
  client: Parameters<CommandHandler>[0]['client']
): Promise<string | undefined> {
  const envHandle = process.env.ORCA_TERMINAL_HANDLE
  if (!envHandle || envHandle.length === 0) {
    return undefined
  }
  let live: boolean
  try {
    live = await isLiveTerminalHandle(envHandle, client)
  } catch (err) {
    if (isOptionalTaskCreatorHandleError(err)) {
      // Why: creator handles are best-effort lineage metadata; graph unavailability must not block task creation.
      return undefined
    }
    throw err
  }
  if (live) {
    return envHandle
  }
  return await resolveOrchestrationPaneTerminalHandle(client, { optional: true })
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

function isOptionalTaskCreatorHandleError(err: unknown): boolean {
  const code = getClientErrorCode(err)
  return code === 'no_active_sender_terminal' || code === 'runtime_unavailable'
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
  return process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') ?? false
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
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid positive integer for --${name}: ${raw}`
    )
  }
  return value
}

function rejectLifecycleGroupRecipient(type: string | undefined, to: string): void {
  if ((type === 'worker_done' || type === 'heartbeat') && to.startsWith('@')) {
    throw new RuntimeClientError('invalid_argument', getLifecycleGroupRecipientError(type))
  }
}

export const ORCHESTRATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration send': async ({ flags, client, cwd, json }) => {
    const to = getRequiredStringFlag(flags, 'to')
    const type = getOptionalStringFlag(flags, 'type')
    rejectLifecycleGroupRecipient(type, to)

    if (
      (type === 'worker_done' || type === 'heartbeat') &&
      !getOptionalStringFlag(flags, 'from') &&
      !process.env.ORCA_TERMINAL_HANDLE
    ) {
      // Why: focus isn't lifecycle authority — an identity-less subprocess must fail closed rather than guess the worker.
      throwNoActiveSenderTerminal()
    }

    // Why: lifecycle senders keep ORCA_TERMINAL_HANDLE verbatim — no liveness probe (worker_done must survive the mid-restart window) and no remint (older runtimes require from === the stale assignee_handle).
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await client.call<OrchestrationSendResult>('orchestration.send', {
      from,
      to,
      subject: getRequiredStringFlag(flags, 'subject'),
      body: getOptionalStringFlag(flags, 'body'),
      type,
      priority: getOptionalStringFlag(flags, 'priority'),
      threadId: getOptionalStringFlag(flags, 'thread-id'),
      payload: getOptionalStructuredMessagePayload(flags),
      // Why: pane key is the remint-stable sender identity the runtime verifies lifecycle ownership against; older runtimes strip it.
      senderPaneKey: process.env.ORCA_PANE_KEY || undefined,
      devMode: isDevCliInvocation()
    })
    if ('message' in result.result && result.result.lifecycle?.action === 'rejected') {
      // Why: a rejected lifecycle signal isn't completion; non-zero exit stops workers from treating it as such.
      process.exitCode = 1
    }
    printResult(result, json, (r) => {
      if ('message' in r) {
        if (r.lifecycle?.action === 'rejected') {
          return `Rejected ${r.message.id}: ${r.lifecycle.reason}`
        }
        return `Sent ${r.message.id}`
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
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')

    // Why: Claude Code auto-backgrounds subprocesses silent ~2 min; emit JSON keepalives to stderr (stdout stays one payload). See §3.4.
    const stopKeepalive = wait ? startCheckKeepalive(timeoutMs) : null
    type CheckResult = {
      messages: MessageSummary[]
      count: number
      formatted?: string
    }
    let result: Awaited<ReturnType<typeof client.call<CheckResult>>>
    try {
      result = await client.call<CheckResult>('orchestration.check', {
        terminal,
        // Why: peek also sends unread:false so pre-peek runtimes degrade to non-consuming all mode instead of destructive mark-read.
        unread: flags.has('unread') ? true : peek ? false : undefined,
        peek: peek ? true : undefined,
        all: flags.has('all') ? true : undefined,
        types: getOptionalStringFlag(flags, 'types'),
        inject: flags.has('inject') ? true : undefined,
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
    printResult(result, json, (r) => {
      if (r.formatted) {
        return r.formatted
      }
      if (r.count === 0) {
        return 'No messages.'
      }
      return r.messages
        .map((m) => `${m.id} [${m.type ?? 'status'}] from=${m.from_handle} "${m.subject}"`)
        .join('\n')
    })
  },

  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await client.call<{ message: { id: string } }>('orchestration.reply', {
      id: getRequiredStringFlag(flags, 'id'),
      body: getRequiredStringFlag(flags, 'body'),
      from
    })
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
          const head = `${m.id} ${m.from_handle} -> ${m.to_handle ?? '?'}: "${m.subject}"`
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

  'orchestration task-create': async ({ flags, client, json }) => {
    const callerTerminalHandle = await resolveTaskCreatorTerminalHandle(client)
    const result = await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskCreate',
      {
        spec: getRequiredStringFlag(flags, 'spec'),
        taskTitle: getOptionalStringFlag(flags, 'task-title'),
        displayName: getOptionalStringFlag(flags, 'display-name'),
        deps: getOptionalStringFlag(flags, 'deps'),
        parent: getOptionalStringFlag(flags, 'parent'),
        callerTerminalHandle
      }
    )
    printResult(result, json, (r) => `Created ${r.task.id} [${r.task.status}]`)
  },

  'orchestration task-list': async ({ flags, client, json }) => {
    const brief = flags.has('brief')
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
    }>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined,
      brief: brief ? true : undefined
    })
    // Why: only older runtimes (no spec_truncated) skip server-side abbreviation and need this client-side fallback.
    const needsClientAbbreviation =
      brief && result.result.tasks.some((task) => task.spec_truncated === undefined)
    const output = needsClientAbbreviation
      ? {
          ...result,
          result: { ...result.result, tasks: abbreviateOrchestrationTasks(result.result.tasks) }
        }
      : result
    printResult(output, json, (r) => {
      if (r.count === 0) {
        return 'No tasks.'
      }
      return r.tasks
        .map((t) => {
          const label = t.display_name ?? t.task_title ?? t.spec
          const head = `${t.id} [${t.status}] ${label.slice(0, 60)}`
          if (t.status === 'dispatched' && t.assignee_handle) {
            return `${head} -> ${t.assignee_handle} (${t.dispatch_id ?? '?'})`
          }
          return head
        })
        .join('\n')
    })
  },

  'orchestration task-update': async ({ flags, client, json }) => {
    const status = getRequiredStringFlag(flags, 'status')
    if (!TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid status '${status}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
      )
    }
    const result = await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status,
        result: getOptionalStringFlag(flags, 'result')
      }
    )
    printResult(result, json, (r) => `Updated ${r.task.id} -> ${r.task.status}`)
  },

  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const dryRun = flags.has('dry-run') ? true : undefined
    const returnPreamble = flags.has('return-preamble') ? true : undefined
    // Why: --to is only required for non-dry-run; the RPC handler re-enforces.
    const to = dryRun ? getOptionalStringFlag(flags, 'to') : getRequiredStringFlag(flags, 'to')
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
      injected?: boolean
      dryRun?: boolean
      preamble?: string
    }>('orchestration.dispatch', {
      task: getRequiredStringFlag(flags, 'task'),
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
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const timeoutMs = parsedTimeoutMs ?? 600_000
    const result = await client.call<{
      answer: string | null
      messageId: string | null
      threadId: string
      timedOut: boolean
    }>(
      'orchestration.ask',
      {
        to: getRequiredStringFlag(flags, 'to'),
        question: getRequiredStringFlag(flags, 'question'),
        options: getOptionalStringFlag(flags, 'options'),
        timeoutMs: parsedTimeoutMs,
        from
      },
      // Why: extend past timeoutMs so the RPC transport's 60s default doesn't abort before the runtime's own timeout resolves.
      { timeoutMs: timeoutMs + 5_000 }
    )
    // Why: bypass printResult so --json emits a bare JSON object (no envelope) pipeable via `jq -r .answer`, unlike other verbs.
    if (json) {
      console.log(JSON.stringify(result.result))
    } else if (result.result.answer !== null) {
      console.log(result.result.answer)
    }
    if (result.result.timedOut) {
      if (!json) {
        console.error(`ask timeout after ${timeoutMs}ms (thread ${result.result.threadId})`)
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

  'orchestration run': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      runId: string
      status: string
    }>('orchestration.run', {
      spec: getRequiredStringFlag(flags, 'spec'),
      from,
      pollIntervalMs: getOptionalPositiveIntegerFlag(flags, 'poll-interval-ms'),
      maxConcurrent: getOptionalPositiveIntegerFlag(flags, 'max-concurrent'),
      worktree: getOptionalStringFlag(flags, 'worktree')
    })
    printResult(result, json, (r) => `Run ${r.runId} started (${r.status})`)
  },

  'orchestration run-stop': async ({ client, json }) => {
    const result = await client.call<{
      runId: string
      stopped: boolean
    }>('orchestration.runStop', {})
    printResult(result, json, (r) => `Run ${r.runId} stopped`)
  },

  'orchestration gate-create': async ({ flags, client, json }) => {
    const result = await client.call<{
      gate: { id: string; task_id: string; status: string }
    }>('orchestration.gateCreate', {
      task: getRequiredStringFlag(flags, 'task'),
      question: getRequiredStringFlag(flags, 'question'),
      options: getOptionalStringFlag(flags, 'options')
    })
    printResult(
      result,
      json,
      (r) => `Gate ${r.gate.id} created for task ${r.gate.task_id} [${r.gate.status}]`
    )
  },

  'orchestration gate-resolve': async ({ flags, client, json }) => {
    const result = await client.call<{
      gate: { id: string; task_id: string; status: string; resolution: string }
    }>('orchestration.gateResolve', {
      id: getRequiredStringFlag(flags, 'id'),
      resolution: getRequiredStringFlag(flags, 'resolution')
    })
    printResult(result, json, (r) => `Gate ${r.gate.id} resolved: ${r.gate.resolution}`)
  },

  'orchestration gate-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      gates: { id: string; task_id: string; question: string; status: string }[]
      count: number
    }>('orchestration.gateList', {
      task: getOptionalStringFlag(flags, 'task'),
      status: getOptionalStringFlag(flags, 'status')
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
    const hasScopeFlag = flags.has('all') || flags.has('tasks') || flags.has('messages')
    const result = await client.call<{ reset: string }>('orchestration.reset', {
      all: flags.has('all') || !hasScopeFlag ? true : undefined,
      tasks: flags.has('tasks') ? true : undefined,
      messages: flags.has('messages') ? true : undefined
    })
    printResult(result, json, (r) => `Reset: ${r.reset}`)
  }
}

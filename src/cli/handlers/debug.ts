import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'
import {
  formatDebugBreakpoint,
  formatDebugBreakpoints,
  formatDebugConfigs,
  formatDebugEvaluate,
  formatDebugEvents,
  formatDebugResult,
  formatDebugStack,
  formatDebugStatus,
  formatDebugVariables,
  formatDebugWait,
  type DebugBreakpoint,
  type DebugConfigListing,
  type DebugEvaluateResult,
  type DebugEventsPage,
  type DebugResult,
  type DebugSnapshot,
  type DebugStackResult,
  type DebugVariablesResult,
  type DebugWaitResult
} from './debug-format'

const WAIT_FOR = ['stopped', 'terminated', 'either'] as const
const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 120_000
// Why: the server bounds the wait itself; the socket must outlive it to receive the timed-out answer.
const WAIT_RPC_GRACE_MS = 5_000
// Why: start and restart spawn an adapter and launch the program, which can outlast the 60 s default.
const LAUNCH_RPC_TIMEOUT_MS = 90_000

const STEP_DIRECTIONS = [
  { flag: 'over', method: 'debug.next', verb: 'over' },
  { flag: 'into', method: 'debug.stepIn', verb: 'into' },
  { flag: 'out', method: 'debug.stepOut', verb: 'out' }
] as const

type Thread = { threadId: number; controlSeq?: number }
type Launched = DebugSnapshot & { controlSeq?: number | null }

/** `wait` already counts from this seq; it is printed for `wait --since` in a later call. */
function withSeq(text: string, controlSeq: number | null | undefined): string {
  return typeof controlSeq === 'number' ? `${text} (control seq ${controlSeq})` : text
}

const formatLaunched = (value: Launched) => withSeq(formatDebugStatus(value), value.controlSeq)

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

async function getDebugWorktree(ctx: HandlerContext): Promise<string> {
  const explicit = await getOptionalWorktreeSelector(ctx.flags, 'worktree', ctx.cwd, ctx.client)
  return explicit ?? (await resolveCurrentWorktreeSelector(ctx.cwd, ctx.client))
}

function getRequiredLine(flags: Map<string, string | boolean>): number {
  const line = getOptionalPositiveIntegerFlag(flags, 'line')
  if (line === undefined) {
    throw invalid('Missing required --line')
  }
  return line
}

function getStepDirection(flags: Map<string, string | boolean>): (typeof STEP_DIRECTIONS)[number] {
  const chosen = STEP_DIRECTIONS.filter((direction) => flags.has(direction.flag))
  if (chosen.length !== 1) {
    throw invalid('Pass exactly one of --over, --into, --out.')
  }
  const [direction] = chosen
  if (flags.get(direction.flag) !== true) {
    throw invalid(`--${direction.flag} takes no value`)
  }
  return direction
}

function getWaitFor(flags: Map<string, string | boolean>): (typeof WAIT_FOR)[number] {
  const value = getOptionalStringFlag(flags, 'for') ?? 'stopped'
  const match = WAIT_FOR.find((candidate) => candidate === value)
  if (match === undefined) {
    throw invalid(`Invalid --for. Use ${WAIT_FOR.join(', ')}.`)
  }
  return match
}

function getWaitTimeoutMs(flags: Map<string, string | boolean>): number {
  const timeoutMs = getOptionalNonNegativeIntegerFlag(flags, 'timeout-ms') ?? DEFAULT_WAIT_MS
  if (timeoutMs > MAX_WAIT_MS) {
    throw invalid(`--timeout-ms must be at most ${MAX_WAIT_MS}`)
  }
  return timeoutMs
}

/** Prints the result; a refusal is not an RPC error, so it sets the exit code here. */
function printDebug<T>(
  response: RuntimeRpcSuccess<DebugResult<T>>,
  json: boolean,
  format: (value: T) => string
): void {
  printResult(response, json, formatDebugResult(format))
  if (!response.result.ok) {
    process.exitCode = 1
  }
}

async function callDebug<T>(
  ctx: HandlerContext,
  method: string,
  params: Record<string, unknown>,
  format: (value: T) => string,
  timeoutMs?: number
): Promise<RuntimeRpcSuccess<DebugResult<T>>> {
  const worktree = await getDebugWorktree(ctx)
  const response =
    timeoutMs === undefined
      ? await ctx.client.call<DebugResult<T>>(method, { worktree, ...params })
      : await ctx.client.call<DebugResult<T>>(method, { worktree, ...params }, { timeoutMs })
  printDebug(response, ctx.json, format)
  return response
}

function threadAction(method: string, label: string): CommandHandler {
  return async (ctx) => {
    const threadId = getOptionalNonNegativeIntegerFlag(ctx.flags, 'thread')
    await callDebug<Thread>(ctx, method, { threadId }, (value) =>
      withSeq(`${label} thread ${value.threadId}.`, value.controlSeq)
    )
  }
}

export const DEBUG_HANDLERS: Record<string, CommandHandler> = {
  'debug status': async (ctx) => {
    await callDebug<DebugSnapshot>(ctx, 'debug.status', {}, formatDebugStatus)
  },
  'debug configs': async (ctx) => {
    await callDebug<DebugConfigListing[]>(ctx, 'debug.configs', {}, formatDebugConfigs)
  },
  'debug start': async (ctx) => {
    const params = {
      config: getOptionalStringFlag(ctx.flags, 'config'),
      file: getOptionalStringFlag(ctx.flags, 'file'),
      line: getOptionalPositiveIntegerFlag(ctx.flags, 'line')
    }
    await callDebug<Launched>(ctx, 'debug.start', params, formatLaunched, LAUNCH_RPC_TIMEOUT_MS)
  },
  'debug stop': async (ctx) => {
    await callDebug<DebugSnapshot>(ctx, 'debug.stop', {}, formatDebugStatus)
  },
  'debug restart': async (ctx) => {
    await callDebug<Launched>(ctx, 'debug.restart', {}, formatLaunched, LAUNCH_RPC_TIMEOUT_MS)
  },
  'debug continue': threadAction('debug.continue', 'Continued'),
  'debug pause': threadAction('debug.pause', 'Paused'),
  'debug step': async (ctx) => {
    const direction = getStepDirection(ctx.flags)
    const threadId = getOptionalNonNegativeIntegerFlag(ctx.flags, 'thread')
    await callDebug<Thread>(ctx, direction.method, { threadId }, (value) =>
      withSeq(`Stepped ${direction.verb} on thread ${value.threadId}.`, value.controlSeq)
    )
  },
  'debug stack': async (ctx) => {
    const params = {
      threadId: getOptionalNonNegativeIntegerFlag(ctx.flags, 'thread'),
      levels: getOptionalPositiveIntegerFlag(ctx.flags, 'levels')
    }
    await callDebug<DebugStackResult>(ctx, 'debug.stack', params, formatDebugStack)
  },
  'debug vars': async (ctx) => {
    const params = {
      frameId: getOptionalNonNegativeIntegerFlag(ctx.flags, 'frame'),
      variablesReference: getOptionalPositiveIntegerFlag(ctx.flags, 'ref'),
      depth: getOptionalNonNegativeIntegerFlag(ctx.flags, 'depth')
    }
    await callDebug<DebugVariablesResult>(ctx, 'debug.variables', params, formatDebugVariables)
  },
  'debug eval': async (ctx) => {
    const params = {
      expression: getRequiredStringFlag(ctx.flags, 'expression'),
      frameId: getOptionalNonNegativeIntegerFlag(ctx.flags, 'frame')
    }
    await callDebug<DebugEvaluateResult>(ctx, 'debug.evaluate', params, formatDebugEvaluate)
  },
  'debug events': async (ctx) => {
    const since = getOptionalNonNegativeIntegerFlag(ctx.flags, 'since') ?? 0
    await callDebug<DebugEventsPage>(ctx, 'debug.events', { since }, formatDebugEvents)
  },
  'debug wait': async (ctx) => {
    const timeoutMs = getWaitTimeoutMs(ctx.flags)
    const since = getOptionalNonNegativeIntegerFlag(ctx.flags, 'since')
    const params = { for: getWaitFor(ctx.flags), timeoutMs, since }
    const response = await callDebug<DebugWaitResult>(
      ctx,
      'debug.wait',
      params,
      formatDebugWait,
      timeoutMs + WAIT_RPC_GRACE_MS
    )
    // Why: callers chain `debug wait && debug stack`; a timeout is an unsatisfied wait.
    if (response.result.ok && response.result.value.timedOut) {
      process.exitCode = 1
    }
  },
  'debug break list': async (ctx) => {
    await callDebug<DebugBreakpoint[]>(ctx, 'debug.breakpoints.list', {}, formatDebugBreakpoints)
  },
  'debug break add': async (ctx) => {
    const params = {
      path: getRequiredStringFlag(ctx.flags, 'path'),
      line: getRequiredLine(ctx.flags),
      condition: getOptionalStringFlag(ctx.flags, 'condition'),
      hitCondition: getOptionalStringFlag(ctx.flags, 'hit-condition'),
      logMessage: getOptionalStringFlag(ctx.flags, 'log-message')
    }
    await callDebug<DebugBreakpoint>(
      ctx,
      'debug.breakpoints.set',
      params,
      (bp) => `Added ${formatDebugBreakpoint(bp)}`
    )
  },
  'debug break rm': async (ctx) => {
    const params = {
      path: getRequiredStringFlag(ctx.flags, 'path'),
      line: getRequiredLine(ctx.flags)
    }
    await callDebug<{ removed: string[] }>(
      ctx,
      'debug.breakpoints.remove',
      params,
      (value) => `Removed ${value.removed.length} breakpoint(s) at ${params.path}:${params.line}.`
    )
  }
}

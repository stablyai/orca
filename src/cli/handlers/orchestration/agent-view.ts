import type { HandlerContext } from '../../dispatch'
import { printResult } from '../../format'
import { formatOrchestrationErrorLine } from '../../cli-error'
import { renderCommand } from '../../orchestration-mutation-recovery'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import type { RuntimeRpcSuccess } from '../../runtime-client'
import { withReceiptNext } from './receipt-next-text'
import { escapeTerminalControlCharacters } from '../../../shared/terminal-control-character-escape'

type AgentViewFields = Record<string, unknown>

/** `warning` keeps the non-zero exit but tells the agent the work may still be fine. */
export type OrchestrationFailure = {
  code: string
  message: string
  exitCode?: number
  level?: 'error' | 'warning'
}

/** What one command prints by default; --full skips it and runs today's printer instead. */
export type OrchestrationAgentView<TResult, TFields extends AgentViewFields> = {
  fields: (result: TResult) => TFields
  /** Defaults to the shared field text; only prose (messages, answers) needs its own. */
  text?: (fields: TFields, result: TResult) => string
  failure?: (result: TResult) => OrchestrationFailure | undefined
}

export function printOrchestrationResult<TResult, TFields extends AgentViewFields>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  view: OrchestrationAgentView<TResult, TFields>
): void {
  const failure = view.failure?.(response.result)
  printOrchestrationFields(
    json,
    view.fields(response.result),
    (fields) => (view.text ? view.text(fields, response.result) : formatAgentFieldsText(fields)),
    !failure || failure.exitCode === 0
  )
  if (failure) {
    reportOrchestrationFailure(failure)
  }
}

function printOrchestrationFields<TFields extends AgentViewFields>(
  json: boolean,
  fields: TFields,
  text: (fields: TFields) => string,
  // A failed outcome reads ok:false even though its fields still describe what happened.
  ok = true
): void {
  // Runtime next steps name `orca`; this is the one place they get the executable in use.
  const resolved: TFields =
    typeof fields.next === 'string'
      ? { ...fields, next: resolveOrcaCommandsInText(fields.next) }
      : fields
  console.log(json ? JSON.stringify({ ok, result: withNextLast(resolved) }) : text(resolved))
}

/** Receipts whose text is the same in both modes; --full is today's printResult, unchanged. */
export function printOrchestrationReceipt<TResult extends AgentViewFields>(
  response: RuntimeRpcSuccess<TResult>,
  ctx: Pick<HandlerContext, 'flags' | 'json'>,
  text: (result: TResult) => string
): void {
  if (ctx.flags.has('full')) {
    printResult(response, ctx.json, text)
  } else {
    printOrchestrationFields(ctx.json, response.result, text)
  }
}

export function reportOrchestrationFailure(failure: OrchestrationFailure): void {
  process.exitCode = failure.exitCode ?? 1
  console.error(formatOrchestrationErrorLine(failure.code, failure.message, failure.level))
}

/**
 * The text twin of the JSON fields: scalars as `name=value` on one line, each list row on its
 * own line, and `Next:` last, so text and --json never carry different facts.
 */
export function formatAgentFieldsText(fields: AgentViewFields): string {
  const head: string[] = []
  const rows: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'next' || value === undefined) {
      continue
    }
    if (Array.isArray(value) && value.some(isFieldRecord)) {
      rows.push(...value.map((row) => (isFieldRecord(row) ? formatFieldPairs(row) : String(row))))
      continue
    }
    head.push(formatFieldPairs({ [key]: value }))
  }
  const next = typeof fields.next === 'string' ? fields.next : undefined
  return withReceiptNext([head.join(' '), ...rows].filter(Boolean).join('\n') || 'none', { next })
}

/** `name=value` pairs with no `Next:` line, for sender-written data. */
export function formatFieldPairs(fields: AgentViewFields, prefix = ''): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      isFieldRecord(value)
        ? formatFieldPairs(value, `${prefix}${key}.`)
        : `${prefix}${key}=${formatFieldValue(value)}`
    )
    .join(' ')
}

function formatFieldValue(value: unknown): string {
  if (value === null) {
    return 'none'
  }
  if (Array.isArray(value)) {
    return value.length ? value.map(formatFieldValue).join(',') : 'none'
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  // Quote anything that would split a name=value pair; never pass raw control bytes to the terminal.
  return escapeTerminalControlCharacters(/^[^\s"',=]+$/.test(text) ? text : JSON.stringify(text))
}

function isFieldRecord(value: unknown): value is AgentViewFields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Agents reading the head get the ids and the tail gets the next step.
function withNextLast(fields: AgentViewFields): AgentViewFields {
  if (!('next' in fields)) {
    return fields
  }
  const { next, ...rest } = fields
  return { ...rest, next }
}

function resolveOrcaCommandsInText(text: string): string {
  const executable = resolveOrchestrationCliExecutable()
  if (executable === 'orca') {
    return text
  }
  const rendered = renderCommand([executable])
  return text.replace(/(^|[\s`'"(])orca(?= orchestration )/gm, (_, lead: string) => lead + rendered)
}

export function renderOrchestrationArgv(argv: readonly string[]): string | undefined {
  if (argv.length === 0) {
    return undefined
  }
  // Fleet next actions are subcommand argv (`orchestration ...`); older hosts named `orca`.
  const subcommand = argv[0] === 'orca' ? argv.slice(1) : argv
  return renderCommand([resolveOrchestrationCliExecutable(), ...subcommand])
}

/** The executable as an agent should type it, quoted for its shell. */
export function orchestrationCliName(): string {
  return renderCommand([resolveOrchestrationCliExecutable()])
}

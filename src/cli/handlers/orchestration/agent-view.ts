import type { HandlerContext } from '../../dispatch'
import { formatOrchestrationErrorLine } from '../../cli-error'
import { printResult } from '../../format'
import { renderCommand } from '../../orchestration-mutation-recovery'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import type { RuntimeRpcSuccess } from '../../runtime-client'

type AgentViewFields = Record<string, unknown>

export type OrchestrationFailure = {
  code: string
  message: string
  exitCode?: number
}

/** What one command prints by default: the same small fields as one-line JSON or plain text. */
export type OrchestrationAgentView<TResult, TFields extends AgentViewFields> = {
  fields: (result: TResult) => TFields
  /** The raw result is for text that needs routing the fields leave out. */
  text: (fields: TFields, result: TResult) => string
  /** Today's text, printed by --full. */
  fullText: (result: TResult) => string
  failure?: (result: TResult) => OrchestrationFailure | undefined
}

export function printOrchestrationResult<TResult, TFields extends AgentViewFields>(
  response: RuntimeRpcSuccess<TResult>,
  ctx: Pick<HandlerContext, 'flags' | 'json'>,
  view: OrchestrationAgentView<TResult, TFields>
): void {
  if (ctx.flags.has('full')) {
    printResult(response, ctx.json, view.fullText)
  } else {
    printOrchestrationFields(ctx.json, view.fields(response.result), (fields) =>
      view.text(fields, response.result)
    )
  }
  const failure = view.failure?.(response.result)
  if (failure) {
    reportOrchestrationFailure(failure)
  }
}

export function printOrchestrationFields<TFields extends AgentViewFields>(
  json: boolean,
  fields: TFields,
  text: (fields: TFields) => string
): void {
  console.log(json ? JSON.stringify({ ok: true, result: withNextLast(fields) }) : text(fields))
}

/** For commands whose text is already short: only the JSON loses fields. */
export function sameTextView<TResult, TFields extends AgentViewFields>(
  fields: (result: TResult) => TFields,
  text: (result: TResult) => string,
  failure?: (result: TResult) => OrchestrationFailure | undefined
): OrchestrationAgentView<TResult, TFields> {
  return { fields, text: (_, result) => text(result), fullText: text, failure }
}

/** Small receipts whose result already is the agent's fields; JSON only loses the envelope. */
export function printOrchestrationReceipt<TResult extends AgentViewFields>(
  response: RuntimeRpcSuccess<TResult>,
  ctx: Pick<HandlerContext, 'flags' | 'json'>,
  text: (result: TResult) => string,
  failure?: (result: TResult) => OrchestrationFailure | undefined
): void {
  printOrchestrationResult(
    response,
    ctx,
    sameTextView((result) => result, text, failure)
  )
}

export function reportOrchestrationFailure(failure: OrchestrationFailure): void {
  process.exitCode = failure.exitCode ?? 1
  console.error(formatOrchestrationErrorLine(failure.code, failure.message))
}

// Agents reading the head get the ids and the tail gets the next step.
function withNextLast(fields: AgentViewFields): AgentViewFields {
  if (!('next' in fields)) {
    return fields
  }
  const { next, ...rest } = fields
  return { ...rest, next }
}

/** Commands printed by the runtime name `orca`; show the executable this agent actually runs. */
export function resolveOrcaCommandsInText(text: string): string {
  const executable = resolveOrchestrationCliExecutable()
  if (executable === 'orca') {
    return text
  }
  const rendered = renderCommand([executable])
  return text.replace(/(^|[\s`'"(])orca(?= orchestration )/g, (_, lead: string) => lead + rendered)
}

export function renderOrchestrationArgv(argv: readonly string[]): string | undefined {
  if (argv.length === 0) {
    return undefined
  }
  return renderCommand(
    argv[0] === 'orca' ? [resolveOrchestrationCliExecutable(), ...argv.slice(1)] : argv
  )
}

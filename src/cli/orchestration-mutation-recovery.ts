import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import {
  recoverableOrchestrationArgs,
  resolveOrchestrationCliExecutable
} from './runtime/orchestration-recovery-command'
import { quoteWindowsCmdArgument } from '../shared/child-process/windows-command-line'
import { quotePowerShellNativeArgument } from '../shared/powershell-native-argument'
import { resolveWindowsShellStartupFamily } from '../shared/windows-terminal-shell'
import type { AgentStartupShell } from '../shared/tui-agent-startup-shell'

export function orchestrationMutationRecoveryError(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError) || !isUnknownMutationOutcomeCode(error.code)) {
    return error
  }
  const data = objectRecord(error.data)
  const requestId = data?.orchestrationRequestId
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return error
  }
  const dispatchId = typeof data?.dispatchId === 'string' ? data.dispatchId : undefined
  const parsedOriginalCommand = commandParts(data?.originalCommand)
  const originalCommand = parsedOriginalCommand
    ? recoverableOrchestrationArgs(parsedOriginalCommand)
    : undefined
  const safeData = { ...data }
  delete safeData.originalCommand
  const retryCommand = originalCommand
    ? [...originalCommand, '--retry-request', requestId]
    : undefined
  const executable = originalCommand?.[0] ?? resolveOrchestrationCliExecutable()
  const queryCommand = dispatchId
    ? [executable, 'orchestration', 'worker-show', '--dispatch', dispatchId, '--json']
    : undefined
  const recovery = {
    orchestrationRequestId: requestId,
    ...(dispatchId ? { dispatchId } : {}),
    ...(queryCommand ? { queryCommand } : {}),
    ...(retryCommand ? { retryCommand } : {}),
    recoveryBlocked: !retryCommand,
    disposition: 'outcome_unknown',
    workerDeathInferred: false
  }
  const retryStep = retryCommand
    ? `Run ${renderCommand(retryCommand)}.`
    : 'Recovery is blocked until the exact original command is available; no retry command was emitted.'
  const nextSteps = queryCommand
    ? [`Run ${renderCommand(queryCommand)} before retrying.`, retryStep]
    : [retryStep]
  const message = [
    stripUnsafeRetryAdvice(error.message, requestId),
    'The orchestration mutation may already have taken effect; do not assume it failed.',
    ...nextSteps,
    typeof data?.failedStage === 'string' ? `Failed stage: ${data.failedStage}.` : undefined,
    Array.isArray(data?.residualResources)
      ? `Residual resources: ${JSON.stringify(data.residualResources)}.`
      : undefined
  ].filter((line): line is string => line !== undefined)
  const recoveredData = {
    ...safeData,
    orchestrationRequestId: requestId,
    ...(originalCommand ? { originalCommand } : {}),
    recovery,
    nextSteps
  }
  // Preserve the RPC failure envelope so --json callers retain the request id and
  // runtime metadata while receiving the structured recovery guidance.
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: {
        ...error.response.error,
        message: message.join('\n'),
        data: recoveredData
      }
    })
  }
  return new RuntimeClientError(error.code, message.join('\n'), recoveredData)
}

function isUnknownMutationOutcomeCode(code: string): boolean {
  return [
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'invalid_runtime_response'
  ].includes(code)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function commandParts(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return [...value]
  }
  if (typeof value === 'string' && value.length > 0) {
    return parseCommandLine(value)
  }
  return undefined
}

function parseCommandLine(value: string): string[] | undefined {
  const parts: string[] = []
  let part = ''
  let quote: "'" | '"' | undefined
  let tokenStarted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === "'") {
      if (character === "'") {
        quote = undefined
      } else {
        part += character
      }
      tokenStarted = true
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined
      } else if (character === '\\' && ['"', '\\'].includes(value[index + 1] ?? '')) {
        part += value[++index]
      } else {
        part += character
      }
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        parts.push(part)
        part = ''
        tokenStarted = false
      }
    } else if (character === '\\' && [' ', '\\', "'", '"'].includes(value[index + 1] ?? '')) {
      part += value[++index]
      tokenStarted = true
    } else {
      part += character
      tokenStarted = true
    }
  }
  if (quote !== undefined) {
    return undefined
  }
  if (tokenStarted) {
    parts.push(part)
  }
  return parts.length > 0 ? parts : undefined
}

export function renderCommand(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const shell = resolveRecoveryShell(platform, env)
  const rendered = command.map((value) => quoteRecoveryArgument(value, shell)).join(' ')
  return shell === 'powershell' && rendered ? `& ${rendered}` : rendered
}

function resolveRecoveryShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): AgentStartupShell {
  if (platform !== 'win32') {
    return 'posix'
  }
  return resolveWindowsShellStartupFamily(
    env.ORCA_TERMINAL_WINDOWS_SHELL ?? env.ORCA_WINDOWS_SHELL ?? env.ComSpec ?? env.COMSPEC
  )
}

function quoteRecoveryArgument(value: string, shell: AgentStartupShell): string {
  if (shell === 'cmd') {
    // cmd has no single-quote syntax and expands %VAR% inside double quotes;
    // use the argv encoder that keeps quote parity and escapes percent pairs.
    return quoteWindowsCmdArgument(value)
  }
  if (shell === 'powershell') {
    return quotePowerShellNativeArgument(value)
  }
  return shellQuote(value)
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function stripUnsafeRetryAdvice(message: string, requestId: string): string {
  return message
    .replace(' Restart Orca and try again.', '')
    .replace(' Retry the command.', '')
    .replace(` Orchestration mutation request ID: ${requestId}.`, '')
}

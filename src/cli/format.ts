import type { CliStatusResult } from '../shared/runtime-types'
import { computerUseErrorRecoveryData } from '../shared/computer-use-error-recovery'
import { prepareComputerCliJsonResult } from './computer-format'
import type { RuntimeRpcFailure, RuntimeRpcSuccess } from './runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

export {
  formatBrowserProfileList,
  formatScreenshot,
  formatSnapshot,
  formatTabList,
  formatTabListWithProfiles,
  formatTabProfileClone,
  formatTabProfileShow,
  formatTabShow
} from './browser-format'

export {
  formatComputerAction,
  formatGetAppState,
  formatListApps,
  formatListWindows
} from './computer-format'
export type { ComputerActionFollowUpTarget } from './computer-format'
export {
  formatProjectHostSetupCreateResult,
  formatProjectHostSetupDeleteResult,
  formatProjectHostSetupList,
  formatProjectHostSetupResult,
  formatProjectHostSetupUpdateResult,
  formatProjectList
} from './project-format'
export {
  formatTerminalClose,
  formatTerminalCreate,
  formatTerminalFocus,
  formatTerminalList,
  formatTerminalRead,
  formatTerminalRename,
  formatTerminalSend,
  formatTerminalShow,
  formatTerminalSplit,
  formatTerminalWait
} from './terminal-format'
export {
  formatAutomationList,
  formatAutomationRemoved,
  formatAutomationRun,
  formatAutomationRuns,
  formatAutomationShow,
  formatEnvironment,
  formatEnvironmentList,
  formatMemorySnapshot,
  formatRepoList,
  formatRepoRefs,
  formatRepoShow,
  formatWorktreeList,
  formatWorktreePs,
  formatWorktreeShow
} from './workspace-format'

type CliErrorContext = {
  commandPath?: readonly string[]
}

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(prepareComputerCliJsonResult(response), null, 2))
    return
  }
  console.log(formatter(response.result))
}

export function formatCliError(error: unknown, context: CliErrorContext = {}): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  // Why: error-specific recovery must win over the generic computer fallback.
  if (error instanceof RuntimeClientError) {
    const nextSteps = nextStepsFromData(error.data)
    if (nextSteps.length > 0) {
      return formatMessageWithNextSteps(message, nextSteps)
    }
    if (error.code === 'invalid_argument' && context.commandPath?.[0] === 'computer') {
      return formatMessageWithNextSteps(
        message,
        computerUseErrorRecoveryData('invalid_argument')?.nextSteps ?? []
      )
    }
  }
  if (
    error instanceof RuntimeRpcFailureError &&
    error.response.error.code === 'runtime_unavailable'
  ) {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  if (error instanceof RuntimeRpcFailureError) {
    return formatMessageWithNextSteps(message, nextStepsFromData(error.response.error.data))
  }
  return message
}

export function reportCliError(error: unknown, json: boolean, context: CliErrorContext = {}): void {
  if (json) {
    if (error instanceof RuntimeRpcFailureError) {
      console.log(JSON.stringify(error.response, null, 2))
    } else {
      const response: RuntimeRpcFailure = {
        id: 'local',
        ok: false,
        error: {
          code: error instanceof RuntimeClientError ? error.code : 'runtime_error',
          message: error instanceof Error ? error.message : String(error),
          data: localCliErrorData(error, context)
        },
        _meta: {
          runtimeId: null
        }
      }
      console.log(JSON.stringify(response, null, 2))
    }
  } else {
    console.error(formatCliError(error, context))
  }
}

function formatMessageWithNextSteps(message: string, nextSteps: readonly string[]): string {
  if (nextSteps.length === 0) {
    return message
  }
  return `${message}\n${nextSteps.map((step) => `Next step: ${step}`).join('\n')}`
}

function nextStepsFromData(data: unknown): string[] {
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { nextSteps?: unknown }).nextSteps)
  ) {
    return (data as { nextSteps: unknown[] }).nextSteps.filter(
      (step): step is string => typeof step === 'string'
    )
  }
  return []
}

function localCliErrorData(error: unknown, context: CliErrorContext): unknown {
  // Why: error-specific recovery must win over the generic computer fallback.
  if (error instanceof RuntimeClientError && error.data !== undefined) {
    return error.data
  }
  if (
    error instanceof RuntimeClientError &&
    error.code === 'invalid_argument' &&
    context.commandPath?.[0] === 'computer'
  ) {
    return computerUseErrorRecoveryData('invalid_argument')
  }
  return undefined
}

export function formatCliStatus(status: CliStatusResult): string {
  return [
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `runtimeState: ${status.runtime.state}`,
    `runtimeReachable: ${status.runtime.reachable}`,
    `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`
  ].join('\n')
}

export function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}

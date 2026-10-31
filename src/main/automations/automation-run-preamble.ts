import {
  localOrchestrationCliCommand,
  type OrchestrationCliCommand
} from '../runtime/orchestration/cli-command'
import { buildAutomationRunPreamble } from '../../shared/automation-run-preamble'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'

/** Reporting reaches only this host's runtime; WSL and SSH terminals are refused, so they are not told. */
export function automationRunReportingCli(
  target: Extract<AutomationRunTargetResult, { ok: true }>,
  readRuntime: () => ProjectExecutionRuntimeResolution | undefined
): OrchestrationCliCommand | null {
  if (getRepoRoutingConnectionId(target.repo) || isWslUncPath(target.cwd)) {
    return null
  }
  try {
    const resolution = readRuntime()
    if (resolution?.status === 'repair-required' || resolution?.runtime.kind === 'wsl') {
      return null
    }
  } catch {
    // An unresolved project runtime cannot prove a local host.
    return null
  }
  return localOrchestrationCliCommand()
}

/** The prompt the agent receives; the saved automation prompt never changes. */
export function automationAgentPrompt(prompt: string, cli: OrchestrationCliCommand | null): string {
  return cli ? `${buildAutomationRunPreamble(cli)}${prompt}` : prompt
}

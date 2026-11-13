import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupReport,
  WorkspaceCleanupRun
} from '../../shared/workspace-cleanup/workspace-cleanup-run'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/types'
import {
  formatWorkspaceCleanupPreview,
  formatWorkspaceCleanupReport,
  formatWorkspaceCleanupRun,
  NO_WORKSPACE_CLEANUP_RULE_ON
} from './workspace-cleanup-format'

// Preview reads Git for every workspace; a run also re-checks and removes each match before it answers.
const WORKSPACE_CLEANUP_EVALUATE_TIMEOUT_MS = 10 * 60_000

async function callWorkspaceCleanup<TResult>(
  client: HandlerContext['client'],
  method: 'workspaceCleanup.preview' | 'workspaceCleanup.runNow' | 'workspaceCleanup.report',
  params?: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await client.call<TResult>(
      method,
      params,
      method === 'workspaceCleanup.report'
        ? undefined
        : { timeoutMs: WORKSPACE_CLEANUP_EVALUATE_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host does not support workspace cleanup commands yet. Update Orca on that host.'
      )
    }
    throw error
  }
}

export const WORKSPACE_CLEANUP_HANDLERS: Record<string, CommandHandler> = {
  'workspace cleanup preview': async ({ client, json }) => {
    printResult(
      await callWorkspaceCleanup<WorkspaceCleanupPreview>(client, 'workspaceCleanup.preview'),
      json,
      formatWorkspaceCleanupPreview
    )
  },
  'workspace cleanup run': async ({ client, json }) => {
    const response = await callWorkspaceCleanup<WorkspaceCleanupRun>(
      client,
      'workspaceCleanup.runNow',
      { trigger: 'cli' }
    )
    // A run with no rule on watches nothing, so its receipt is empty.
    const rulesOff =
      !json &&
      response.result.rows.length === 0 &&
      !response.result.error &&
      (await callWorkspaceCleanup<WorkspaceCleanupReport>(client, 'workspaceCleanup.report')).result
        .nextRunAt === null
    printResult(response, json, (run) =>
      rulesOff ? NO_WORKSPACE_CLEANUP_RULE_ON : formatWorkspaceCleanupRun(run)
    )
  },
  'workspace cleanup report': async ({ client, json }) => {
    printResult(
      await callWorkspaceCleanup<WorkspaceCleanupReport>(client, 'workspaceCleanup.report'),
      json,
      formatWorkspaceCleanupReport
    )
  }
}

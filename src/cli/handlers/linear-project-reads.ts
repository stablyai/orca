import type {
  LinearProjectLabelsResult,
  LinearProjectShowResult,
  LinearProjectStatusesResult
} from '../../shared/linear/project-agent-access'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  formatLinearProjectLabels,
  formatLinearProjectShow,
  formatLinearProjectStatuses,
  printLinearProjectLabelsWarnings,
  printLinearProjectResult,
  printLinearProjectStatusesWarnings
} from '../linear-project-format'
import {
  buildProjectShowRequest,
  buildProjectWorkspaceReadRequest
} from '../linear-project-request-builders'
import { rewriteUnsupportedLinearProjectHost } from '../linear-project-unsupported-host'
import type { RuntimeRpcSuccess } from '../runtime/types'

export const LINEAR_PROJECT_READS_HANDLERS: Record<string, CommandHandler> = {
  'linear project show': async ({ flags, client, json }) => {
    const request = buildProjectShowRequest(flags)
    const response = await callLinearProjectRead<LinearProjectShowResult>(
      client,
      'linear.agentProjectShow',
      request,
      'linear project show'
    )
    printLinearProjectResult(response, json, formatLinearProjectShow)
  },
  'linear project statuses': async ({ flags, client, json }) => {
    const response = await callLinearProjectRead<LinearProjectStatusesResult>(
      client,
      'linear.agentProjectStatuses',
      buildProjectWorkspaceReadRequest(flags),
      'linear project statuses'
    )
    if (!json) {
      printLinearProjectStatusesWarnings(response.result)
    }
    printLinearProjectResult(response, json, formatLinearProjectStatuses)
  },
  'linear project labels': async ({ flags, client, json }) => {
    const response = await callLinearProjectRead<LinearProjectLabelsResult>(
      client,
      'linear.agentProjectLabels',
      buildProjectWorkspaceReadRequest(flags),
      'linear project labels'
    )
    if (!json) {
      printLinearProjectLabelsWarnings(response.result)
    }
    printLinearProjectResult(response, json, formatLinearProjectLabels)
  }
}

async function callLinearProjectRead<TResult>(
  client: HandlerContext['client'],
  method: string,
  request: unknown,
  command: string
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await client.call<TResult>(method, request)
  } catch (error) {
    throw rewriteUnsupportedLinearProjectHost(error, command)
  }
}

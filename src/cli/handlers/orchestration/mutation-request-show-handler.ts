import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { OrchestrationMutationRequestShowResult } from '../../../shared/orchestration-mutation-request'

export const ORCHESTRATION_REQUEST_SHOW_HANDLER: Record<string, CommandHandler> = {
  'orchestration request-show': async ({ flags, client, json }) => {
    const request = getRequiredStringFlag(flags, 'request')
    const result = await client
      .call<OrchestrationMutationRequestShowResult>('orchestration.requestShow', { request })
      .catch((error: unknown) => {
        // Why: an Orca server older than request-show answers method_not_found, which reads
        // as a bug rather than a version gap on the very path a lost response sends you down.
        if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
          throw new RuntimeClientError(
            'incompatible_runtime',
            'This Orca server cannot look up orchestration mutation requests yet. Update Orca on the server, or inspect the Dispatch directly with orchestration worker-show.'
          )
        }
        throw error
      })
    printResult(
      result,
      json,
      (value) =>
        `${value.requestId} [${value.state}]${value.method ? ` ${value.method}` : ''}\n${value.interpretation}`
    )
  }
}

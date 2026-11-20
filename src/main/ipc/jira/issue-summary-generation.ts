import { registerAppHandler, appDocumentFor } from '../app-registry/app-handler-registry'

import {
  GenerateIssueSummary,
  CancelGenerateIssueSummary
} from '../../../shared/rpc-contract/jira/jira-params'
import type { Store } from '../../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import {
  cancelJiraIssueSummaryRequest,
  generateJiraIssueSummaryRequest
} from '../../text-generation/requests/jira-issue-summary-requests'
import { addFanoutListener } from '../../runtime/events/event-listener-fanout'

export function registerJiraIssueSummaryGenerationHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  registerAppHandler('jira:generateIssueSummary', async (event, args: unknown) => {
    const request = GenerateIssueSummary.parse(args)
    const owner = `window:${appDocumentFor(event).id}`
    const cancel = (): void => cancelJiraIssueSummaryRequest(owner, request)
    const releaseDestroyed = addFanoutListener(appDocumentFor(event), 'destroyed', cancel)
    try {
      return await generateJiraIssueSummaryRequest(
        {
          getSettings: () => store.getSettings(),
          getAgentEnvironment: () => commitMessageAgentEnv
        },
        owner,
        request
      )
    } finally {
      releaseDestroyed()
    }
  })
  registerAppHandler('jira:cancelGenerateIssueSummary', (event, args: unknown) => {
    cancelJiraIssueSummaryRequest(
      `window:${appDocumentFor(event).id}`,
      CancelGenerateIssueSummary.parse(args)
    )
  })
}

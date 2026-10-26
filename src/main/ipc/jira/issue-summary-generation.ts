import { ipcMain } from 'electron'
import {
  GenerateIssueSummary,
  CancelGenerateIssueSummary
} from '../../../shared/rpc-contract/jira-params'
import type { Store } from '../../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/commit-message-agent-environment'
import {
  cancelJiraIssueSummaryRequest,
  generateJiraIssueSummaryRequest
} from '../../text-generation/jira-issue-summary-requests'

export function registerJiraIssueSummaryGenerationHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  ipcMain.handle('jira:generateIssueSummary', async (event, args: unknown) => {
    const request = GenerateIssueSummary.parse(args)
    const owner = `window:${event.sender.id}`
    const cancel = (): void => cancelJiraIssueSummaryRequest(owner, request)
    event.sender.once('destroyed', cancel)
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
      event.sender.removeListener('destroyed', cancel)
    }
  })
  ipcMain.handle('jira:cancelGenerateIssueSummary', (event, args: unknown) => {
    cancelJiraIssueSummaryRequest(
      `window:${event.sender.id}`,
      CancelGenerateIssueSummary.parse(args)
    )
  })
}

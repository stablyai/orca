import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
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
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('jira:generateIssueSummary', async (event, args: unknown) => {
    const request = GenerateIssueSummary.parse(args)
    const owner = `window:${event.sender.id}`
    const cancel = (): void => cancelJiraIssueSummaryRequest(owner, request)
    const releaseDestroyed = addFanoutListener(event.sender, 'destroyed', cancel)
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
  ipc.handle('jira:cancelGenerateIssueSummary', (event, args: unknown) => {
    cancelJiraIssueSummaryRequest(
      `window:${event.sender.id}`,
      CancelGenerateIssueSummary.parse(args)
    )
  })
}

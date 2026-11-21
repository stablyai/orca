// A setup's browser page must be one of its own agent's tabs: a stale or copied page id would let one
// agent's key download finish another agent's setup.
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { InvalidArgumentError } from '../runtime/rpc/core'

export async function requireSetupPageInAgentWorkspace(
  runtime: Pick<OrcaRuntimeService, 'bots' | 'browserPageWorkspaceId'>,
  botId: string,
  change: object
): Promise<void> {
  const page = 'browserPageId' in change ? change.browserPageId : undefined
  if (typeof page !== 'string' || !page) {
    return
  }
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  const workspace = runtime.browserPageWorkspaceId(page)
  if (!bot || workspace !== folderWorkspaceKey(bot.folderWorkspaceId)) {
    throw new InvalidArgumentError(
      `Browser page ${page} isn't one of this agent's tabs. Open the setup's tab from your own folder with \`tab create\` and use its id.`
    )
  }
}

// A deleted bot's workspace links go with it, here and on each paired server, so its workspaces read as
// nobody's again.
import { WorktreeReleaseBotHome } from '../../../../shared/rpc-contract/bots-params'
import {
  folderWorkspaceKey,
  isWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { listEnvironments } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'

/** Best-effort: an unreachable or older server keeps its link until the bot's next delete reaches it. */
export async function releaseBotHomeOnServers(
  runtime: OrcaRuntimeService,
  botHomeKey: string,
  environmentIds?: readonly string[]
): Promise<void> {
  const ids =
    environmentIds ??
    (await listEnvironments(getAppEnvironment().getPath('userData'))).map(({ id }) => id)
  const installationId = await runtime.readStoreInstallationId().catch(() => undefined)
  await Promise.allSettled(
    ids.map((id) =>
      runtime.callOrchestrationWorkerServer(
        id,
        'worktree.releaseBotHome',
        { botHomeKey, ...(installationId ? { installationId } : {}) },
        5000
      )
    )
  )
}

/** A link outlives a home removed by hand, and a paired server's never sees the removal. */
export function releaseDeletedBotLinks(
  runtime: OrcaRuntimeService,
  bot: { folderWorkspaceId: string }
): void {
  const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
  runtime.releaseBotHome(homeKey)
  void releaseBotHomeOnServers(runtime, homeKey)
}

export const WORKTREE_RELEASE_BOT_HOME_METHOD = defineMethod({
  name: 'worktree.releaseBotHome',
  permission: 'workspace',
  share: 'not-shared',
  params: WorktreeReleaseBotHome,
  handler: ({ botHomeKey, installationId }, { runtime }) =>
    isWorkspaceKey(botHomeKey)
      ? runtime.releaseBotHome(botHomeKey, installationId)
      : { released: 0 }
})

// A setup's browser page must be one of its own agent's tabs: a stale or copied page id would let one
// agent's key download finish another agent's setup.
import type { z } from 'zod'
import type { GoogleSetupWrite } from '../../shared/rpc-contract/google-setup-params'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { getRuntimeBrowserPageRegistry } from '../runtime/browser/client-pages/runtime-browser-page-registry'
import type { Bot } from '../../shared/bot-types'
import { InvalidArgumentError } from '../runtime/rpc/core'

/** This host's own browser, when it has one: which workspace a tab of it belongs to. */
let ownBrowserPageWorkspace: ((browserPageId: string) => string | null) | null = null

export function setOwnBrowserPageWorkspace(
  next: ((browserPageId: string) => string | null) | null
): void {
  ownBrowserPageWorkspace = next
}

export function requireSetupPageInAgentWorkspace(
  runtime: { bots: { list(): readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[] } },
  botId: string,
  change: z.infer<typeof GoogleSetupWrite>['change']
): void {
  const page = 'browserPageId' in change ? change.browserPageId : undefined
  if (!page) {
    return
  }
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  const workspace =
    getRuntimeBrowserPageRegistry(runtime).getPage(page)?.workspaceId ??
    ownBrowserPageWorkspace?.(page) ??
    null
  if (!bot || workspace !== folderWorkspaceKey(bot.folderWorkspaceId)) {
    throw new InvalidArgumentError(
      `Browser page ${page} isn't one of this agent's tabs. Open the setup's tab from your own folder with \`tab create\` and use its id.`
    )
  }
}

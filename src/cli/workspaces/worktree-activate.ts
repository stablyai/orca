import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { getRequiredWorktreeSelector } from '../workspace-selection/workspace-selector'
import { folderIdOfSelector } from '../../shared/workspace/identity/workspace-scope'
import { refuseFolderWorkspaceActivation } from './folder-workspace-mutations'

type WorktreeActivateResult = {
  worktreeId: string
  hostWindow?: 'requested' | 'none' | 'unavailable'
}

function formatWorktreeActivate(
  { worktreeId, hostWindow }: WorktreeActivateResult,
  remote: boolean,
  name: string | null
): string {
  const computer = remote ? (name ?? 'the paired computer') : 'this computer'
  if (hostWindow === 'none') {
    return `No screen changed: no Orca window is open on ${computer} to show ${worktreeId}.`
  }
  if (hostWindow === 'unavailable') {
    return `No screen changed: could not send the request to the Orca window on ${computer} to open ${worktreeId}.`
  }
  const scope = remote
    ? name
      ? `Remote window only (${name})`
      : 'Remote window only'
    : 'Local window only'
  const request =
    hostWindow === 'requested'
      ? `sent a request to the Orca window on ${computer} to open ${worktreeId}.`
      : `sent a request to open ${worktreeId} on ${computer}. This Orca version does not report whether a window received the request.`
  return `${scope}: ${request} No screen changes on any other computer, phone, or Slack.`
}

export const WORKTREE_ACTIVATE_HANDLERS: Record<string, CommandHandler> = {
  // Opening a workspace is the request that wakes a sleeping recipe VM behind it (#36923).
  'worktree activate': async ({ flags, client, cwd, json }) => {
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const folderId = folderIdOfSelector(worktree)
    if (folderId !== undefined) {
      refuseFolderWorkspaceActivation(folderId)
    }
    const result = await client.call<WorktreeActivateResult>('worktree.activate', {
      worktree,
      // A paired caller's default is its own view; the CLI asks the host window only.
      navigation: 'host'
    })
    printResult(result, json, (value) =>
      formatWorktreeActivate(value, client.isRemote, client.environmentSelector)
    )
  }
}

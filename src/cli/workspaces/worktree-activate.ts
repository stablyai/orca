import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { getRequiredWorktreeSelector } from '../workspace-selection/workspace-selector'
import { folderIdOfSelector } from '../../shared/workspace/identity/workspace-scope'
import { refuseFolderWorkspaceActivation } from './folder-workspace-mutations'

type WorktreeActivateResult = { worktreeId: string; hostWindow?: 'open' | 'none' }

/** The host whose window `navigation: 'host'` reaches: this computer, or the paired one named. */
export type ActivatedHost = { kind: 'local' } | { kind: 'remote'; name: string | null }

/**
 * Says whose screen changed: only the host's own window, never a paired computer, a phone or Slack.
 * An agent repeats the leading words, so the limit comes before the verb.
 */
export function formatWorktreeActivate(
  { worktreeId, hostWindow }: WorktreeActivateResult,
  host: ActivatedHost
): string {
  const computer =
    host.kind === 'local' ? 'this computer' : (host.name ?? 'the paired computer')
  if (hostWindow === 'open') {
    const scope =
      host.kind === 'local'
        ? 'Local window only'
        : `Remote window only${host.name ? ` (${host.name})` : ''}`
    return `${scope}: switched Orca on ${computer} to ${worktreeId}. Nothing changed on any other computer, phone, or Slack.`
  }
  if (hostWindow === 'none') {
    return `No screen changed: no Orca window is open on ${computer} to switch to ${worktreeId}.`
  }
  // An older host doesn't say whether it has a window.
  return `Activated ${worktreeId}`
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
      // A paired caller's default is its own view; the CLI opens the workspace on its host.
      navigation: 'host'
    })
    const host: ActivatedHost = client.isRemote
      ? { kind: 'remote', name: client.environmentSelector }
      : { kind: 'local' }
    printResult(result, json, (value) => formatWorktreeActivate(value, host))
  }
}

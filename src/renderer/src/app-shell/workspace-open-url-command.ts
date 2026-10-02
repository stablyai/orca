import { getActiveWorkspaceUrl, openWorkspaceUrlInOrcaBrowser } from '@/lib/workspace-url-open'
import type { KeybindingActionId } from '../../../shared/keybindings/types'

/** Claims the shortcut only when the active workspace has a saved link. */
export function claimOpenWorkspaceUrl(
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
): boolean {
  const link = getActiveWorkspaceUrl()
  return link
    ? claim('workspace.openUrl', () => openWorkspaceUrlInOrcaBrowser(link.worktreeId, link.url))
    : false
}

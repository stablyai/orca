import type { VoiceScreenSnapshot } from '../../shared/voice-control-types'

/**
 * Model-facing rendering of the describe_screen snapshot: one compact spoken-friendly
 * paragraph. The model reads this aloud-able text and answers "what am I looking at?"
 * from it directly.
 */
export function formatVoiceScreenSnapshot(snapshot: VoiceScreenSnapshot): string {
  const parts: string[] = []
  const branch = snapshot.worktreeBranch ? ` (branch ${snapshot.worktreeBranch})` : ''
  parts.push(
    snapshot.worktreeName
      ? `The user is on the ${snapshot.view} view in workspace "${snapshot.worktreeName}"${branch}.`
      : `The user is on the ${snapshot.view} view; no workspace is selected.`
  )
  if (snapshot.tabs.length > 0) {
    const tabs = snapshot.tabs
      .map((tab) => `${tab.title} (${tab.contentType}${tab.active ? ', focused' : ''})`)
      .join('; ')
    parts.push(`Open tabs: ${tabs}.`)
  } else {
    parts.push('No tabs are open.')
  }
  parts.push(`Left sidebar ${snapshot.leftSidebarOpen ? 'open' : 'closed'}.`)
  parts.push(
    snapshot.rightSidebar
      ? `Right sidebar open on ${snapshot.rightSidebar}.`
      : 'Right sidebar closed.'
  )
  return parts.join(' ')
}

import { createHash } from 'node:crypto'
import type { ShortcutViewer, ShortcutWorkspace } from '../../shared/shortcut-types'

// Keyed on slug + member so two accounts in one workspace stay distinct
// connections instead of silently overwriting each other's token.
export function getShortcutWorkspaceId(urlSlug: string, memberId: string): string {
  return createHash('sha256')
    .update(`${urlSlug}\n${memberId.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

export function toShortcutWorkspace(data: Record<string, unknown>): ShortcutWorkspace | null {
  const workspace =
    data.workspace2 && typeof data.workspace2 === 'object'
      ? (data.workspace2 as Record<string, unknown>)
      : {}
  const memberId = typeof data.id === 'string' ? data.id : ''
  const urlSlug = typeof workspace.url_slug === 'string' ? workspace.url_slug : ''
  if (!memberId || !urlSlug) {
    return null
  }
  const mentionName = typeof data.mention_name === 'string' ? data.mention_name : ''
  return {
    id: getShortcutWorkspaceId(urlSlug, memberId),
    urlSlug,
    name: typeof workspace.name === 'string' && workspace.name ? workspace.name : urlSlug,
    memberId,
    memberName: typeof data.name === 'string' && data.name ? data.name : mentionName,
    mentionName
  }
}

export function workspaceToViewer(workspace: ShortcutWorkspace | null): ShortcutViewer | null {
  if (!workspace) {
    return null
  }
  return {
    id: workspace.memberId,
    name: workspace.memberName,
    mentionName: workspace.mentionName
  }
}

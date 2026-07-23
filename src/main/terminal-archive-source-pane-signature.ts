import { createHash } from 'node:crypto'
import type { ArchivedTerminalPane } from '../shared/terminal-archive-types'

export type TerminalArchiveSourcePaneIdentity = {
  paneKey: string
  incarnationId: string
}

export function makeTerminalArchiveSourcePaneSignature(
  panesByLeafId: Record<string, ArchivedTerminalPane>,
  sourcePaneIdentityByLeafId: Record<string, TerminalArchiveSourcePaneIdentity>
): string {
  const leafIds = Object.keys(panesByLeafId).sort()
  if (leafIds.length !== Object.keys(sourcePaneIdentityByLeafId).length) {
    throw new Error('Terminal archive source pane identities must match archived panes')
  }
  const canonical = leafIds.map((leafId) => {
    const sourcePane = sourcePaneIdentityByLeafId[leafId]
    if (!sourcePane?.paneKey || !sourcePane.incarnationId) {
      throw new Error('Terminal archive source pane identities must include an incarnation')
    }
    return [leafId, sourcePane.paneKey, sourcePane.incarnationId]
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

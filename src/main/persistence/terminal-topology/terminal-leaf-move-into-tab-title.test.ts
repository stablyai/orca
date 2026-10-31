import { describe, expect, it } from 'vitest'
import {
  A,
  intoRequest,
  intoTabSession,
  localPartition,
  SOURCE,
  TARGET,
  WT
} from './terminal-leaf-move-into-tab-fixture'
import { planTerminalLeafMoveIntoTab } from './terminal-leaf-move-into-tab'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

function titledSource(customTitle: string | null, paneTitle?: string): WorkspaceSessionState {
  const session = intoTabSession()
  session.tabsByWorktree[WT] = session.tabsByWorktree[WT]!.map((tab) =>
    tab.id === SOURCE ? { ...tab, customTitle } : tab
  )
  const layout = session.terminalLayoutsByTabId[SOURCE]!
  session.terminalLayoutsByTabId[SOURCE] = {
    ...layout,
    titlesByLeafId: paneTitle === undefined ? {} : { [A]: paneTitle }
  }
  return session
}

function movedTitle(session: WorkspaceSessionState): string | undefined {
  const planned = planTerminalLeafMoveIntoTab(localPartition(session), intoRequest)
  expect(planned.result.status).toBe('moved')
  return planned.sessions[0]!.session.terminalLayoutsByTabId[TARGET]!.titlesByLeafId?.[A]
}

describe('a join carries the source tab custom title (decision 7)', () => {
  it('writes the source customTitle as the moved pane title when the leaf has none', () => {
    expect(movedTitle(titledSource('My build'))).toBe('My build')
  })

  it('keeps the leaf own title over the tab custom title', () => {
    expect(movedTitle(titledSource('My build', 'agent title'))).toBe('agent title')
  })

  it('carries nothing when the source has no custom title', () => {
    expect(movedTitle(titledSource(null))).toBeUndefined()
  })
})

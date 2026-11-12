import { describe, expect, it } from 'vitest'
import type { VoiceScreenSnapshot } from '../../shared/voice-control-types'
import { formatVoiceScreenSnapshot } from './voice-control-screen-description'

function snapshot(overrides: Partial<VoiceScreenSnapshot> = {}): VoiceScreenSnapshot {
  return {
    view: 'worktree',
    worktreeName: 'oak',
    tabs: [
      { title: 'README.md', contentType: 'file', active: true },
      { title: 'Terminal 1', contentType: 'terminal', active: false }
    ],
    leftSidebarOpen: true,
    rightSidebar: null,
    ...overrides
  }
}

describe('formatVoiceScreenSnapshot', () => {
  it('names the view, workspace, focused tab, and sidebar state', () => {
    const text = formatVoiceScreenSnapshot(snapshot())
    expect(text).toBe(
      'The user is on the worktree view in workspace "oak". ' +
        'Open tabs: README.md (file, focused); Terminal 1 (terminal). ' +
        'Left sidebar open. Right sidebar closed.'
    )
  })

  it('says when no workspace is selected and no tabs are open', () => {
    const text = formatVoiceScreenSnapshot(
      snapshot({ view: 'settings', worktreeName: null, tabs: [] })
    )
    expect(text).toContain('on the settings view; no workspace is selected')
    expect(text).toContain('No tabs are open.')
  })

  it('names the right sidebar tab when open', () => {
    const text = formatVoiceScreenSnapshot(snapshot({ rightSidebar: 'explorer' }))
    expect(text).toContain('Right sidebar open on explorer.')
  })

  // Display names collide (two worktrees named "main"); the branch is the disambiguator
  // the sidebar shows, so the model can tell which "main" the user is looking at.
  it('includes the workspace branch when the renderer reports one', () => {
    const text = formatVoiceScreenSnapshot(
      snapshot({ worktreeName: 'main', worktreeBranch: 'j-madrone/main' })
    )
    expect(text).toContain('workspace "main" (branch j-madrone/main)')
  })
})

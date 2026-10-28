import { describe, expect, it } from 'vitest'
import { buildNotchRowLabel } from './notch-row-label'

const FALLBACK = 'Session'

describe('buildNotchRowLabel', () => {
  it('shows the branch for an ordinary git worktree', () => {
    expect(
      buildNotchRowLabel({
        worktree: { displayName: 'checkout-fix', branch: 'feat/checkout', head: 'abc1234def' },
        fallbackTitle: FALLBACK
      })
    ).toEqual({ title: 'checkout-fix', subtitle: 'feat/checkout' })
  })

  it('leaves a folder workspace with no second line', () => {
    // Why: folderWorkspaceToWorktree sets branch and head to '', so there is no git identity.
    expect(
      buildNotchRowLabel({
        worktree: { displayName: 'design-notes', branch: '', head: '' },
        fallbackTitle: FALLBACK
      })
    ).toEqual({ title: 'design-notes', subtitle: '' })
  })

  it('shortens a detached HEAD to a readable SHA', () => {
    expect(
      buildNotchRowLabel({
        worktree: { displayName: 'bisect', branch: '', head: '0123456789abcdef' },
        fallbackTitle: FALLBACK
      }).subtitle
    ).toBe('0123456')
  })

  it('prefers the agent type when the workspace is unknown', () => {
    expect(
      buildNotchRowLabel({ worktree: null, agentType: 'claude', fallbackTitle: FALLBACK })
    ).toEqual({ title: 'claude', subtitle: '' })
  })

  it('falls back to the supplied title when nothing else is known', () => {
    expect(buildNotchRowLabel({ worktree: null, fallbackTitle: FALLBACK }).title).toBe(FALLBACK)
  })

  it('treats a whitespace-only display name as absent', () => {
    expect(
      buildNotchRowLabel({
        worktree: { displayName: '   ', branch: 'main', head: '' },
        agentType: 'codex',
        fallbackTitle: FALLBACK
      }).title
    ).toBe('codex')
  })

  it('ignores a whitespace-only branch rather than rendering a blank line', () => {
    expect(
      buildNotchRowLabel({
        worktree: { displayName: 'wt', branch: '  ', head: 'deadbeefcafe' },
        fallbackTitle: FALLBACK
      }).subtitle
    ).toBe('deadbee')
  })
})

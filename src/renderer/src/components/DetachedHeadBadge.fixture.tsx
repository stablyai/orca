import { getWorktreeGitIdentityDisplay } from '../../../shared/worktree/git-identity-display'
import { defineFixture } from '../component-fixtures/component-fixture'
import { DetachedHeadBadge } from './DetachedHeadBadge'

function detachedDisplay(): Parameters<typeof DetachedHeadBadge>[0]['display'] {
  const display = getWorktreeGitIdentityDisplay({
    head: '3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a'
  })
  if (display?.kind !== 'detached') {
    throw new Error('Expected a detached HEAD display.')
  }
  return display
}

export const labels = defineFixture({
  width: 320,
  render: () => (
    <div className="flex flex-col items-start gap-2">
      <DetachedHeadBadge display={detachedDisplay()} label="sidebar" />
      <DetachedHeadBadge display={detachedDisplay()} label="source-control" />
    </div>
  )
})

// Mirrors the sidebar card meta row, which renders the badge at 16px tall.
export const inSidebarMetaRow = defineFixture({
  width: 300,
  render: () => (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border p-1.5 text-xs">
      <span className="truncate font-medium">fix-login</span>
      <DetachedHeadBadge display={detachedDisplay()} label="sidebar" className="h-[16px]" />
    </div>
  )
})

import { expect, it } from 'vitest'
import { normalizeNotificationSettings } from '../persistence/applying-settings/onboarding-normalization'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { mergeFolderWorkspace } from '../ipc/worktrees/folder-workspace-model'
import { mergeRuntimeFolderWorkspace } from '../runtime/runtime-folder-workspace'
import { getWorkspaceNotificationOrigin } from '../../shared/workspace-notification-policy'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

it('defaults missing and invalid older settings to on and preserves explicit mutes', () => {
  for (const input of [
    undefined,
    {},
    { cliWorktreeTaskComplete: 'false', automationWorktreeTaskComplete: null }
  ]) {
    expect(normalizeNotificationSettings(input)).toMatchObject({
      cliWorktreeTaskComplete: true,
      automationWorktreeTaskComplete: true
    })
  }
  expect(
    normalizeNotificationSettings({
      cliWorktreeTaskComplete: false,
      automationWorktreeTaskComplete: false
    })
  ).toMatchObject({ cliWorktreeTaskComplete: false, automationWorktreeTaskComplete: false })
})

it.each(['local', 'ssh:server', 'runtime:server'] as const)(
  'projects legacy CLI origin for Git and folder workspaces on %s',
  (hostId) => {
    const repo: Repo = {
      id: 'repo',
      path: '/project',
      displayName: 'Project',
      badgeColor: 'blue',
      addedAt: 0
    }
    const meta: WorktreeMeta = {
      hostId,
      orcaCreationSource: 'cli',
      displayName: 'CLI workspace',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
    const rows = [
      mergeWorktree(
        repo.id,
        {
          path: '/project/feature',
          head: 'abc',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        },
        meta
      ),
      mergeFolderWorkspace(repo, 'repo::/project', meta),
      mergeRuntimeFolderWorkspace(repo, 'repo::/project', meta)
    ]
    for (const row of rows) {
      expect(row.orcaCreationSource).toBe('cli')
      expect(getWorkspaceNotificationOrigin(row)).toBe('cli')
    }
  }
)

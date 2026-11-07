import '../../rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  root,
  B,
  authorityProfile,
  openAuthorityRuntime
} from './structured-agent-session-tab-authority.test-support'
import { closeStructuredAgentSessionChild } from '../structured-agent-session-close'

// CLI capability probing is outside tab authority and must not start a real CLI in this fixture.
vi.mock('../../../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))
beforeEach(() => {
  layoutOwner.main = false
})

it('captured close retires only its qualified workspace and preserves unrelated mirrors', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
  await rig.host.setSessionTabVisibility(B, true)
  rig.runtime.projectStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'codex',
    activate: true
  })
  const original = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
  const duplicate = rig.profile.createFolderWorkspace({
    projectGroupId: rig.groupId,
    folderPath: `${root}/duplicate`,
    name: 'Duplicate'
  })
  const mirror = rig.profile.createFolderWorkspace({
    projectGroupId: rig.groupId,
    folderPath: `${root}/mirror`,
    name: 'Mirror',
    connectionId: 'foreign'
  })
  const duplicateKey = folderWorkspaceKey(duplicate.id),
    mirrorKey = folderWorkspaceKey(mirror.id)
  rig.runtime.storeMobileSessionSnapshot(duplicateKey, { ...original, worktree: duplicateKey })
  const foreign = rig.runtime.storeMobileSessionSnapshot(mirrorKey, {
    ...original,
    worktree: mirrorKey
  })
  await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
  expect(rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs).toEqual([])
  expect(rig.runtime.mobileSessionTabsByWorktree.get(duplicateKey)?.tabs).toEqual(original.tabs)
  expect(rig.runtime.mobileSessionTabsByWorktree.get(mirrorKey)).toBe(foreign)
  expect(rig.runtime.retireStructuredAgentSessionTabFromSnapshot(B)).toBe(false)
  expect(rig.runtime.mobileSessionTabsByWorktree.get(mirrorKey)).toBe(foreign)
})

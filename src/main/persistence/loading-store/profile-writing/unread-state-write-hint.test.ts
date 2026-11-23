import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import '../../../../shared/worktree/identity'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { closeTestStores, createStore, makeRepo, testState } from '../../persistence-test-harness'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-unread-hint-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

// The phone badge recounts only on writes without the hint, so a flag change must never carry it.
it('marks only the record writes that keep every unread and archived flag', () => {
  const store = createStore()
  store.addRepo(makeRepo({ id: 'repo-1', path: '/workspace' }))
  const group = store.createProjectGroup({
    name: 'Notes',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  const target = hostWorktreeTarget({ id: 'repo-1::/workspace/feature', hostId: 'local' })
  store.setWorktreeMeta(target, { displayName: 'Feature' })
  const hints: (boolean | undefined)[] = []
  store.onStateWritten((_domains, options) => hints.push(options?.preservesUnreadState))

  store.setWorktreeMeta(target, { lastActivityAt: 1 })
  store.setWorktreeMeta(target, { isUnread: true })
  store.setWorktreeMeta(target, { isUnread: true, lastTerminalUseAt: 2 })
  store.setWorktreeMeta(target, { isArchived: true })
  store.setWorktreeMeta(target, { isUnread: false })
  store.updateFolderWorkspace(folder.id, { lastActivityAt: 3 })
  store.updateFolderWorkspace(folder.id, { isUnread: true })
  store.updateFolderWorkspace(folder.id, { folderPath: join(testState.dir, 'moved') })
  store.updateFolderWorkspace(folder.id, { isArchived: true })

  expect(hints).toEqual([
    true,
    undefined,
    true,
    undefined,
    undefined,
    true,
    undefined,
    undefined,
    undefined
  ])
})

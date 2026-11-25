import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { chatWorkspaceNameUpdate } from './chat-workspace-name'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import { listRuntimeFolderWorkspaces } from '../workspaces/catalog/runtime-worktree-filesystem'
import { listFolderWorkspaces } from '../../ipc/worktrees/listing/folder-workspace-catalog'
import { hostWorktreeTargetForRepo } from '../../persistence/host-qualified-worktree-meta'

const roots: string[] = []
afterEach(async () => {
  await closeTestStores()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('allocates one folder per creation and persists only the first submitted chat’s generated name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-chat-workspace-'))
  roots.push(root)
  const dataFile = join(root, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  const controller = new RuntimeRepositoryRegistrationController({
    getStore: () => store,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  const name = '2026-11-24-11111111-1111-4111-8111-111111111111'
  const created = await controller.createChatWorkspace(name, 'New project-20261124')
  if (!('repo' in created)) {
    throw new Error(created.error)
  }
  expect(created.repo.path).toBe(join(root, 'chats', name))
  expect(created.repo.kind).toBe('folder')
  expect(listRuntimeFolderWorkspaces(store, created.repo)[0]!.displayName).toBe(
    'New project-20261124'
  )
  expect(await controller.createChatWorkspace(name, 'New project-20261124')).toEqual(created)
  await expect(controller.createChatWorkspace('../outside', 'New project')).rejects.toThrow(
    'Invalid'
  )
  const first = { sessionId: 'first-with-query', conversationName: 'Plan a release' }
  const later = { sessionId: 'later', conversationName: 'Other question' }
  const submissions = [
    { sessionId: 'later', submittedAt: 20 },
    { sessionId: 'first-with-query', submittedAt: 10 }
  ]
  expect(chatWorkspaceNameUpdate(created.repo, later, submissions)).toBeNull()
  const update = chatWorkspaceNameUpdate(created.repo, first, submissions)!
  store.updateRepo(created.repo, update)
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  const reopened = createSqliteTestStore(Store, { dataFile })
  const saved = reopened.getRepo(created.repo.id)!
  expect(saved.displayName).toBe('Plan a release')
  const workspace = listRuntimeFolderWorkspaces(reopened, saved)[0]!
  expect(workspace.displayName).toBe('Plan a release')
  expect(listFolderWorkspaces(reopened, saved)[0]!.displayName).toBe('Plan a release')
  reopened.setWorktreeMeta(hostWorktreeTargetForRepo(workspace.id, saved), {
    displayName: 'My workspace',
    displayNameIsPinned: true
  })
  expect(listRuntimeFolderWorkspaces(reopened, saved)[0]!.displayName).toBe('My workspace')
  expect(listFolderWorkspaces(reopened, saved)[0]!.displayName).toBe('My workspace')
  expect(saved.chatWorkspace?.autoName).toBe(false)
  expect(chatWorkspaceNameUpdate(saved, later, submissions)).toBeNull()
  reopened.updateRepo(saved, { chatWorkspace: { initialName: saved.displayName, autoName: true } })
  reopened.updateRepo(saved, { displayName: 'My notes' })
  reopened.updateRepo(saved, { displayName: 'Plan a release' })
  expect(chatWorkspaceNameUpdate(reopened.getRepo(saved.id)!, first, submissions)).toBeNull()
})

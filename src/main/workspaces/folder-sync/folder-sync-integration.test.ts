import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FOLDER_PROJECT_SYNC_CAPABILITY } from '../../../shared/project/folder-project-sync'
import type { Repo } from '../../../shared/repository/repo-types'
import { Store } from '../../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { FILE_METHODS } from '../../runtime/rpc/methods/files/files'
import { PROJECT_RUNTIME_METHODS } from '../../runtime/rpc/methods/projects/project-runtime-rpc-methods'
import { DesktopFolderSync } from './desktop-folder-sync'

const environmentId = 'loopback-server'
let root: string
let dispatcher: RpcDispatcher
let runtime: OrcaRuntimeService
let sync: DesktopFolderSync

vi.mock(
  '../../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveEnvironment: async () => ({ id: environmentId, createdAt: 100 })
  })
)
vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: async (
    _userData: string,
    _env: string,
    method: string,
    params: unknown
  ) =>
    method === 'status.get'
      ? {
          ok: true,
          result: {
            runtimeId: runtime.getRuntimeId(),
            capabilities: [FOLDER_PROJECT_SYNC_CAPABILITY]
          }
        }
      : dispatcher.dispatch({ id: 'request', authToken: 'token', method, params })
}))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-folder-sync-integration-'))
  const store = createSqliteTestStore(Store, { dataFile: join(root, 'server-state.json') })
  store.updateSettings({ workspaceDir: join(root, 'server-projects') })
  runtime = new OrcaRuntimeService(store)
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [...PROJECT_RUNTIME_METHODS, ...FILE_METHODS]
  })
})
afterEach(async () => {
  sync?.dispose()
  await closeTestStores()
  await rm(root, { recursive: true, force: true })
})

async function localFolder(id: string, name: string): Promise<Repo> {
  const path = join(root, name)
  await mkdir(join(path, 'nested'), { recursive: true })
  await writeFile(join(path, 'nested', 'data.bin'), Buffer.alloc(410_000, 24))
  return { id, displayName: name, path, kind: 'folder', badgeColor: '', addedAt: 1 }
}

it('provisions a linked server folder and persists the desktop sync preference', async () => {
  const copied = await localFolder('05ade9c6-c7ae-426e-a597-93f737d35335', 'copied')
  const empty = await localFolder('5bd96010-8ad9-4763-b3a3-fca54dab7749', 'empty')
  const statePath = join(root, 'folder-sync.json')
  sync = new DesktopFolderSync(root, statePath, () => [copied, empty])

  const copyTarget = { environmentId, sourceRepoId: copied.id }
  const copy = await sync.setup({ ...copyTarget, copyContents: true, autoSync: true })
  expect(copy.path.startsWith(join(root, 'server-projects'))).toBe(true)
  expect(await readFile(join(copy.path, 'nested', 'data.bin'))).toEqual(Buffer.alloc(410_000, 24))
  expect(runtime.listVisibleProjectHostSetups()).toContainEqual(
    expect.objectContaining({
      projectId: 'repo:05ade9c6-c7ae-426e-a597-93f737d35335',
      repoId: copy.id
    })
  )

  const noCopy = await sync.setup({
    environmentId,
    sourceRepoId: empty.id,
    copyContents: false,
    autoSync: false
  })
  expect(await readdir(noCopy.path)).toEqual([])
  expect(await readFile(join(empty.path, 'nested', 'data.bin'))).toHaveLength(410_000)

  sync.dispose()
  sync = new DesktopFolderSync(root, statePath, () => [copied, empty])
  expect((await sync.getStatus(copyTarget))?.autoSync).toBe(true)
  await sync.setPreference({ ...copyTarget, autoSync: false })
  expect((await sync.getStatus(copyTarget))?.autoSync).toBe(false)
})

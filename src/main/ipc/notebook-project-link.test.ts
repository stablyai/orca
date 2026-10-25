import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

type Handler = (event: unknown, args: unknown) => unknown

const { handlers, startNotebookKernelMock, userData } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  startNotebookKernelMock: vi.fn(),
  userData: { path: '' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
}))
vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})
vi.mock('../notebook/notebook-kernel', () => ({ startNotebookKernel: startNotebookKernelMock }))

import { registerNotebookHandlers } from './notebook'

let base: string
let project: string

function storeWithProject(projectPath: string): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
  return {
    getRepos: () => [
      { id: 'repo', path: projectPath, displayName: 'project', badgeColor: '#000', addedAt: 0 }
    ],
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  handlers.clear()
  startNotebookKernelMock.mockReset().mockReturnValue({
    kernel: { execute: vi.fn(), interrupt: vi.fn(), shutdown: vi.fn() },
    ready: Promise.resolve({ status: 'ready' }),
    exited: new Promise(() => {})
  })
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-notebook-link-'))
  project = join(base, 'project')
  userData.path = join(base, 'user-data')
  await mkdir(join(project, 'analysis'), { recursive: true })
  await mkdir(join(userData.path, 'floating-workspace'), { recursive: true })
  await writeFile(join(project, 'analysis', 'real.ipynb'), '{}')
  registerNotebookHandlers(storeWithProject(project))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')(
  'runs a notebook opened through a project link in its real folder, as the project check resolves it',
  async () => {
    await symlink(join(project, 'analysis', 'real.ipynb'), join(project, 'nb.ipynb'))
    const owner = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })

    await handlers.get('notebook:startKernel')!(
      { sender: owner },
      { filePath: join(project, 'nb.ipynb'), python: '/py' }
    )

    expect(startNotebookKernelMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: join(project, 'analysis') })
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'runs a linked notebook outside every project in its real folder, as before',
  async () => {
    const notes = join(base, 'notes')
    await mkdir(join(notes, 'analysis'), { recursive: true })
    await writeFile(join(notes, 'analysis', 'real.ipynb'), '{}')
    await symlink(join(notes, 'analysis', 'real.ipynb'), join(notes, 'nb.ipynb'))
    const owner = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })

    await handlers.get('notebook:startKernel')!(
      { sender: owner },
      { filePath: join(notes, 'nb.ipynb'), python: '/py' }
    )

    expect(startNotebookKernelMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: join(notes, 'analysis') })
    )
  }
)

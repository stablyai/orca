import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import type { Store } from '../../../persistence/loading-store/store'
import type * as RepoWorktrees from '../../../workspaces/catalog/repo-worktrees'
import { resolveAuthorizedPath } from './filesystem-auth'
import {
  resolveDesktopAuthorizedPath,
  resolveLocalFileRequestPath,
  resolveLocalListRequestPath
} from './local-file-access-resolution'
import { readLocalFileContent } from '../filesystem-file-content-inspection'
import { invalidateAuthorizedRootsCache } from '../../worktrees/removal/registered-worktree-roots-cache'

const { userData } = vi.hoisted(() => ({ userData: { path: '' } }))

vi.mock('electron', () => ({ app: { getPath: () => userData.path } }))
vi.mock('../../../workspaces/catalog/repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>(
    '../../../workspaces/catalog/repo-worktrees'
  )
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

type Registration = { repoPaths?: string[]; folderPath?: string }

function makeStore({ repoPaths = [], folderPath }: Registration): Store {
  const repos = repoPaths.map((path, index) => ({
    id: `repo-${index}`,
    path,
    displayName: 'project',
    badgeColor: '#000',
    addedAt: 0
  }))
  const folders = folderPath ? [{ id: 'folder', folderPath, projectGroupId: 'none' }] : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
  return {
    getRepos: () => repos.map((repo) => ({ ...repo })),
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => folders.map((folder) => ({ ...folder })),
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

const USER_FILE = { kind: 'user-file' } as const
const PROJECT_FOLDER_LINK = { kind: 'project-folder-link' } as const
const documentResource = (documentPath: string) =>
  ({ kind: 'document-resource', documentPath }) as const

async function settles(promise: Promise<unknown>): Promise<'ok' | 'denied'> {
  return promise.then(
    () => 'ok',
    () => 'denied'
  )
}

let base: string
let project: string
let outside: string

beforeEach(async () => {
  // Floating paths use AppEnvironment in desktop and headless runtimes.
  installFakeAppEnvironment({ getPath: () => userData.path })
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-file-access-'))
  project = join(base, 'project')
  outside = join(base, 'outside')
  userData.path = join(base, 'user-data')
  await mkdir(project)
  await mkdir(outside)
  await mkdir(join(userData.path, 'floating-workspace'), { recursive: true })
  await writeFile(join(outside, 'notes.txt'), 'outside notes\n')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('user-file requests', () => {
  it('read a regular file outside every project in place', async () => {
    const store = makeStore({})
    const filePath = await resolveLocalFileRequestPath(join(outside, 'notes.txt'), USER_FILE, store)

    await expect(readLocalFileContent(filePath)).resolves.toEqual({
      content: 'outside notes\n',
      isBinary: false
    })
  })
})

describe('requests with no declared access (roots only)', () => {
  it('refuse a file outside every project, even one a user-file request may read', async () => {
    const store = makeStore({ repoPaths: [project] })

    await expect(
      resolveLocalFileRequestPath(join(outside, 'notes.txt'), undefined, store)
    ).rejects.toThrow('Access denied')
    await expect(
      resolveLocalFileRequestPath(join(outside, 'notes.txt'), { kind: 'grant-everything' }, store)
    ).rejects.toThrow('Access denied')
  })

  it('allow the app-owned floating-workspace folder on the desktop only', async () => {
    const store = makeStore({ repoPaths: [project] })
    const untitled = join(userData.path, 'floating-workspace', 'untitled.md')

    await expect(resolveDesktopAuthorizedPath(untitled, store)).resolves.toBe(untitled)
    await expect(resolveAuthorizedPath(untitled, store)).rejects.toThrow('Access denied')
  })

  it('refuse the home folder, which the floating workspace starts in', async () => {
    await expect(
      resolveDesktopAuthorizedPath(homedir(), makeStore({ repoPaths: [project] }))
    ).rejects.toThrow('Access denied')
  })
})

// Windows symlinks require elevation or Developer Mode.
describe.skipIf(process.platform === 'win32')('project symlinks under every spelling', () => {
  let real: string
  let alias: string
  let alias2: string
  let privateBase: string
  let varAlias: string
  let secret: string

  beforeEach(async () => {
    // Mirrors macOS /var -> /private/var: an alias of an ancestor above the project root.
    privateBase = join(base, 'private')
    varAlias = join(base, 'var')
    real = join(privateBase, 'real', 'project')
    alias = join(base, 'alias-project')
    alias2 = join(base, 'alias2-project')
    await mkdir(join(real, 'sub'), { recursive: true })
    await symlink(privateBase, varAlias)
    await symlink(real, alias)
    await symlink(real, alias2)
    secret = join(outside, 'secret.txt')
    await writeFile(secret, 'secret\n')
    await writeFile(join(real, 'notes.md'), 'notes\n')
    await symlink(secret, join(real, 'escape.txt'))
    await symlink(outside, join(real, 'dir-link'))
    await symlink(outside, join(real, 'sub', 'deep-link'))
  })

  it('reads a project link the user opened by name in place, while project requests stay refused', async () => {
    const store = makeStore({ repoPaths: [real] })
    const link = join(real, 'escape.txt')

    expect(await settles(resolveLocalFileRequestPath(link, undefined, store))).toBe('denied')
    const named = await resolveLocalFileRequestPath(link, USER_FILE, store)
    await expect(readLocalFileContent(named)).resolves.toEqual({
      content: 'secret\n',
      isBinary: false
    })
  })
})

describe('document-resource requests', () => {
  let otherProject: string

  beforeEach(async () => {
    otherProject = join(base, 'other-project')
    await mkdir(join(project, 'docs'), { recursive: true })
    await mkdir(otherProject)
    await writeFile(join(project, 'docs', 'README.md'), '# doc\n')
    await writeFile(join(project, 'logo.png'), 'png')
    await writeFile(join(otherProject, 'shared.png'), 'png')
    await writeFile(join(project, 'notes.txt'), 'text')
    await writeFile(join(outside, 'outside.png'), 'png')
    await mkdir(join(outside, 'doc-folder', 'img'), { recursive: true })
    await writeFile(join(outside, 'doc-folder', 'note.md'), '# note\n')
    await writeFile(join(outside, 'doc-folder', 'img', 'nested.png'), 'png')
    await writeFile(join(outside, 'doc-folder', 'sibling.png'), 'png')
  })

  it('limit a document outside every project to its own folder', async () => {
    const store = makeStore({ repoPaths: [project] })
    const access = documentResource(join(outside, 'doc-folder', 'note.md'))
    const outcome = (path: string) => settles(resolveLocalFileRequestPath(path, access, store))

    expect(await outcome(join(outside, 'doc-folder', 'sibling.png'))).toBe('ok')
    expect(await outcome(join(outside, 'doc-folder', 'img', 'nested.png'))).toBe('ok')
    expect(await outcome(join(outside, 'outside.png'))).toBe('denied')
    expect(await outcome('/dev/zero')).toBe('denied')
  })

  it.skipIf(process.platform === 'win32')(
    'refuse a symlink in the document folder that leads out of it',
    async () => {
      const store = makeStore({})
      await symlink(join(outside, 'outside.png'), join(outside, 'doc-folder', 'escape.png'))
      const access = documentResource(join(outside, 'doc-folder', 'note.md'))

      expect(
        await settles(
          resolveLocalFileRequestPath(join(outside, 'doc-folder', 'escape.png'), access, store)
        )
      ).toBe('denied')
    }
  )
})

describe('chat-image requests', () => {
  const CHAT_IMAGE = { kind: 'chat-image' } as const

  it.skipIf(process.platform === 'win32')(
    'refuse an image-named link to a text file or a device',
    async () => {
      await symlink(join(outside, 'notes.txt'), join(outside, 'secret.png'))
      await symlink('/dev/zero', join(outside, 'zero.png'))
      const store = makeStore({})

      expect(
        await settles(resolveLocalFileRequestPath(join(outside, 'secret.png'), CHAT_IMAGE, store))
      ).toBe('denied')
      expect(
        await settles(resolveLocalFileRequestPath(join(outside, 'zero.png'), CHAT_IMAGE, store))
      ).toBe('denied')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'show an image-named link to an extensionless file only when its bytes are an image',
    async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
      await writeFile(join(outside, 'photo'), png)
      await writeFile(join(outside, 'notes'), 'outside notes\n')
      await symlink(join(outside, 'photo'), join(outside, 'photo.jpg'))
      await symlink(join(outside, 'notes'), join(outside, 'notes.jpg'))
      const store = makeStore({})

      const imagePath = await resolveLocalFileRequestPath(
        join(outside, 'photo.jpg'),
        CHAT_IMAGE,
        store
      )
      await expect(readLocalFileContent(imagePath, { imageBySignature: true })).resolves.toEqual({
        content: png.toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
      expect(
        await settles(resolveLocalFileRequestPath(join(outside, 'notes.jpg'), CHAT_IMAGE, store))
      ).toBe('denied')
    }
  )
})

describe('project-folder-link listings', () => {
  beforeEach(async () => {
    await mkdir(join(outside, 'guides'))
    await symlink(outside, join(project, 'linked'), 'dir')
  })

  it('list a project folder link that leads out, and folders under it', async () => {
    const store = makeStore({ repoPaths: [project] })
    const linked = join(project, 'linked')

    await expect(resolveLocalListRequestPath(linked, undefined, store)).rejects.toThrow(
      'outside allowed directories'
    )
    await expect(resolveLocalListRequestPath(linked, PROJECT_FOLDER_LINK, store)).resolves.toBe(
      outside
    )
    await expect(
      resolveLocalListRequestPath(join(linked, 'guides'), PROJECT_FOLDER_LINK, store)
    ).resolves.toBe(join(outside, 'guides'))
  })

  it('refuse links in Orca floating folder, which is not a project', async () => {
    const floatingLink = join(userData.path, 'floating-workspace', 'linked')
    await symlink(outside, floatingLink, 'dir')

    expect(
      await settles(resolveLocalListRequestPath(floatingLink, PROJECT_FOLDER_LINK, makeStore({})))
    ).toBe('denied')
  })
})

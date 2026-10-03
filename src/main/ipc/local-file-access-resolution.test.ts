import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { resolveAuthorizedPath } from './filesystem-auth'
import {
  resolveDesktopAuthorizedPath,
  resolveLocalFileRequestPath,
  resolveLocalRenamePaths,
  resolveLocalRequestPath,
  resolveLocalWriteRequestPath,
  type LocalRequestOperation
} from './local-file-access-resolution'
import { readLocalFileContent } from './filesystem/filesystem-file-content-inspection'
import {
  assertLocalWriteTargetIsRegularFile,
  NOT_A_REGULAR_FILE_MESSAGE
} from './filesystem/local-regular-file-read'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

const { userData } = vi.hoisted(() => ({ userData: { path: '' } }))

vi.mock('electron', () => ({ app: { getPath: () => userData.path } }))
vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
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
const documentResource = (documentPath: string) =>
  ({ kind: 'document-resource', documentPath }) as const
const documentFolder = (documentPath: string) =>
  ({ kind: 'document-folder', documentPath }) as const

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

  it.each(['notes.txt', 'C:notes.txt'])('refuse the non-absolute path %s', async (relative) => {
    await expect(resolveLocalFileRequestPath(relative, USER_FILE, makeStore({}))).rejects.toThrow(
      'absolute path'
    )
  })

  it('stat a directory but never read one', async () => {
    const dirPath = await resolveLocalFileRequestPath(outside, USER_FILE, makeStore({}))

    expect((await stat(dirPath)).isDirectory()).toBe(true)
    await expect(readLocalFileContent(dirPath)).rejects.toThrow()
  })

  it('save an outside file, but never onto a device', async () => {
    const store = makeStore({})
    const filePath = join(outside, 'notes.txt')

    await expect(resolveLocalWriteRequestPath(filePath, USER_FILE, store)).resolves.toBe(filePath)
    await expect(resolveLocalWriteRequestPath(filePath, undefined, store)).rejects.toThrow(
      'Access denied'
    )
    if (process.platform !== 'win32') {
      await expect(assertLocalWriteTargetIsRegularFile('/dev/null')).rejects.toThrow(
        NOT_A_REGULAR_FILE_MESSAGE
      )
    }
  })

  it.skipIf(process.platform === 'win32')('refuse /dev/zero promptly', async () => {
    const filePath = await resolveLocalFileRequestPath('/dev/zero', USER_FILE, makeStore({}))

    await expect(readLocalFileContent(filePath)).rejects.toThrow(NOT_A_REGULAR_FILE_MESSAGE)
  })
})

describe('a declared kind never refuses what the default project check allows', () => {
  const outsideDocument = () => join(outside, 'doc-folder', 'note.md')
  const declaredKinds = (): [string, unknown, LocalRequestOperation][] => [
    ['user-file read', USER_FILE, 'read'],
    ['user-file write', USER_FILE, 'write'],
    ['document-resource read', documentResource(outsideDocument()), 'read'],
    ['chat-image read', { kind: 'chat-image' }, 'read'],
    [
      'document-folder import-into',
      { kind: 'document-folder', documentPath: outsideDocument() },
      'import-into'
    ]
  ]

  beforeEach(async () => {
    await mkdir(join(project, 'src'), { recursive: true })
    await mkdir(join(outside, 'doc-folder'), { recursive: true })
    await writeFile(join(project, 'src', 'notes.txt'), 'text')
  })

  it('accepts every in-project path the default accepts, for every kind and operation', async () => {
    const store = makeStore({ repoPaths: [project] })
    const targets = [
      join(project, 'src', 'notes.txt'),
      join(project, 'src'),
      join(project, 'src', 'new-name.txt'),
      join(userData.path, 'floating-workspace', 'scratch.md')
    ]
    for (const [label, access, operation] of declaredKinds()) {
      for (const target of targets) {
        const byDefault = await resolveLocalRequestPath(target, undefined, store, operation)
        await expect(
          resolveLocalRequestPath(target, access, store, operation),
          `${label} ${target}`
        ).resolves.toBe(byDefault)
      }
    }
  })

  it.skipIf(process.platform === 'win32')(
    'accepts an in-project link for every kind exactly as the default does',
    async () => {
      await symlink(join(project, 'src', 'notes.txt'), join(project, 'notes-link'))
      const store = makeStore({ repoPaths: [project] })
      for (const [label, access, operation] of declaredKinds()) {
        const byDefault = await resolveLocalRequestPath(
          join(project, 'notes-link'),
          undefined,
          store,
          operation
        )
        await expect(
          resolveLocalRequestPath(join(project, 'notes-link'), access, store, operation),
          label
        ).resolves.toBe(byDefault)
      }
    }
  )

  it('renames an in-project document exactly as the default does', async () => {
    const store = makeStore({ repoPaths: [project] })
    const source = join(project, 'src', 'notes.txt')
    for (const target of [
      join(project, 'src', 'new-name.txt'),
      join(project, 'new-name.txt'),
      join(userData.path, 'floating-workspace', 'scratch.md')
    ]) {
      const byDefault = await resolveLocalRenamePaths(source, target, undefined, store)
      await expect(
        resolveLocalRenamePaths(source, target, documentFolder(source), store),
        target
      ).resolves.toEqual(byDefault)
    }
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

// Why: creating a symlink on Windows needs elevation or Developer Mode.
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

  const viaDirLink = (root: string): string => join(root, 'dir-link', 'secret.txt')

  it.each<[string, () => Registration, () => string]>([
    ['a leaf symlink', () => ({ repoPaths: [real] }), () => join(real, 'escape.txt')],
    ['a directory symlink', () => ({ repoPaths: [real] }), () => viaDirLink(real)],
    ['a directory symlink via an alias', () => ({ repoPaths: [real] }), () => viaDirLink(alias)],
    [
      'a directory symlink, registered and named via two aliases',
      () => ({ repoPaths: [alias] }),
      () => viaDirLink(alias2)
    ],
    [
      'a directory symlink, registered via alias and named canonically',
      () => ({ folderPath: alias }),
      () => viaDirLink(real)
    ],
    [
      'a deep directory symlink in a folder workspace',
      () => ({ folderPath: real }),
      () => join(alias, 'sub', 'deep-link', 'secret.txt')
    ],
    [
      'a directory symlink named with `..`',
      () => ({ repoPaths: [real] }),
      () => join(alias, 'sub', '..', 'dir-link', 'secret.txt')
    ],
    [
      'a directory symlink via an ancestor alias',
      () => ({ repoPaths: [real] }),
      () => viaDirLink(real.replace(privateBase, varAlias))
    ],
    [
      'a leaf symlink via an ancestor alias',
      () => ({ repoPaths: [real] }),
      () => join(real.replace(privateBase, varAlias), 'escape.txt')
    ]
  ])('never read or write through %s out of the project', async (_label, register, named) => {
    const store = makeStore(register())

    expect(await settles(resolveLocalFileRequestPath(named(), undefined, store))).toBe('denied')
    expect(await settles(resolveLocalWriteRequestPath(named(), undefined, store))).toBe('denied')
    expect(await settles(resolveLocalFileRequestPath(secret, undefined, store))).toBe('denied')
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

  it('limit a project document to every project root, whatever the file type', async () => {
    const store = makeStore({ repoPaths: [project, otherProject] })
    const access = documentResource(join(project, 'docs', 'README.md'))
    const outcome = (path: string) => settles(resolveLocalFileRequestPath(path, access, store))

    expect(await outcome(join(project, 'logo.png'))).toBe('ok')
    expect(await outcome(join(otherProject, 'shared.png'))).toBe('ok')
    expect(await outcome(join(project, 'notes.txt'))).toBe('ok')
    expect(await outcome(join(outside, 'outside.png'))).toBe('denied')
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

  it.skipIf(process.platform === 'win32')(
    'read a link of any name in a project or beside the document when its target stays there',
    async () => {
      await writeFile(join(outside, 'doc-folder', 'diagram'), 'png')
      await symlink(join(outside, 'doc-folder', 'diagram'), join(outside, 'doc-folder', 'a.png'))
      await symlink(join(project, 'notes.txt'), join(project, 'notes-link'))
      const store = makeStore({ repoPaths: [project] })

      const inProject = documentResource(join(project, 'docs', 'README.md'))
      const besideDoc = documentResource(join(outside, 'doc-folder', 'note.md'))
      expect(
        await settles(resolveLocalFileRequestPath(join(project, 'notes-link'), inProject, store))
      ).toBe('ok')
      expect(
        await settles(
          resolveLocalFileRequestPath(join(outside, 'doc-folder', 'a.png'), besideDoc, store)
        )
      ).toBe('ok')
    }
  )
})

describe('chat-image requests', () => {
  const CHAT_IMAGE = { kind: 'chat-image' } as const

  it('read any local image file in place, whatever turn named it', async () => {
    const shot = join(outside, 'shot.png')
    await writeFile(shot, 'png')

    const filePath = await resolveLocalFileRequestPath(shot, CHAT_IMAGE, makeStore({}))

    await expect(readLocalFileContent(filePath)).resolves.toMatchObject({
      isBinary: true,
      mimeType: 'image/png'
    })
  })

  it.each(['shot.avif', 'shot.bmp', 'shot.ico', 'shot.svg', 'shot.webp'])(
    'read %s',
    async (name) => {
      await writeFile(join(outside, name), 'image')
      expect(
        await settles(resolveLocalFileRequestPath(join(outside, name), CHAT_IMAGE, makeStore({})))
      ).toBe('ok')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'judge a link by its target: an extensionless link to an image loads',
    async () => {
      await writeFile(join(outside, 'shot.png'), 'png')
      await symlink(join(outside, 'shot.png'), join(outside, 'latest-screenshot'))

      expect(
        await settles(
          resolveLocalFileRequestPath(join(outside, 'latest-screenshot'), CHAT_IMAGE, makeStore({}))
        )
      ).toBe('ok')
    }
  )

  it.each(['notes.txt', 'missing.png'])('refuse %s', async (name) => {
    expect(
      await settles(resolveLocalFileRequestPath(join(outside, name), CHAT_IMAGE, makeStore({})))
    ).toBe('denied')
  })

  it('refuse a relative path, a device and a PDF', async () => {
    const store = makeStore({})
    await writeFile(join(outside, 'doc.pdf'), '%PDF')

    expect(await settles(resolveLocalFileRequestPath('shot.png', CHAT_IMAGE, store))).toBe('denied')
    expect(await settles(resolveLocalFileRequestPath('/dev/zero', CHAT_IMAGE, store))).toBe(
      'denied'
    )
    expect(
      await settles(resolveLocalFileRequestPath(join(outside, 'doc.pdf'), CHAT_IMAGE, store))
    ).toBe('denied')
  })

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
})

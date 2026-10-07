import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

type Handler = (event: unknown, args: unknown) => Promise<unknown>

const { handlers, userData } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
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

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

let projectPaths: string[] = []

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const STORE = {
  getRepos: () =>
    projectPaths.map((path, index) => ({
      id: `repo-${index}`,
      path,
      displayName: 'project',
      badgeColor: '#000',
      addedAt: 0
    })),
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

const documentFolder = (documentPath: string) => ({ kind: 'document-folder', documentPath })

async function settles(promise: Promise<unknown>): Promise<'ok' | 'denied'> {
  return promise.then(
    () => 'ok',
    () => 'denied'
  )
}

function call(channel: string, args: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler(null, args)
}

let base: string
let docFolder: string
let note: string

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  handlers.clear()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-document-folder-'))
  userData.path = join(base, 'user-data')
  docFolder = join(base, 'notes')
  note = join(docFolder, 'note.md')
  await mkdir(join(userData.path, 'floating-workspace'), { recursive: true })
  await mkdir(docFolder)
  await writeFile(note, '# note\n')
  await writeFile(join(base, 'shot.png'), 'png')
  projectPaths = []
  registerFilesystemMutationHandlers(STORE)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('renaming a document the user opened outside every project', () => {
  it('renames it within its own folder', async () => {
    const renamed = join(docFolder, 'renamed.md')

    await call('fs:rename', { oldPath: note, newPath: renamed, access: documentFolder(note) })

    expect(await readdir(docFolder)).toEqual(['renamed.md'])
  })

  it('refuses another file, a relative new name, and a request with no access', async () => {
    await writeFile(join(docFolder, 'other.md'), 'other')

    expect(
      await settles(
        call('fs:rename', {
          oldPath: join(docFolder, 'other.md'),
          newPath: join(docFolder, 'moved.md'),
          access: documentFolder(note)
        })
      )
    ).toBe('denied')
    expect(
      await settles(
        call('fs:rename', { oldPath: note, newPath: 'moved.md', access: documentFolder(note) })
      )
    ).toBe('denied')
    expect(
      await settles(call('fs:rename', { oldPath: note, newPath: join(docFolder, 'plain.md') }))
    ).toBe('denied')
    expect((await readdir(docFolder)).sort()).toEqual(['note.md', 'other.md'])
  })

  it('undoes a rename with the renamed file declared as the document', async () => {
    const renamed = join(docFolder, 'renamed.md')
    await call('fs:rename', { oldPath: note, newPath: renamed, access: documentFolder(note) })

    await call('fs:rename', { oldPath: renamed, newPath: note, access: documentFolder(renamed) })

    expect(await readdir(docFolder)).toEqual(['note.md'])
  })

  // Why each destination is undone: the Undo declares the moved file, so it must come back from anywhere.
  it('moves it into another outside folder, and Undo brings it back', async () => {
    await mkdir(join(base, 'other'))
    const moved = join(base, 'other', 'note.md')

    await call('fs:rename', { oldPath: note, newPath: moved, access: documentFolder(note) })
    expect(await readdir(join(base, 'other'))).toEqual(['note.md'])

    await call('fs:rename', { oldPath: moved, newPath: note, access: documentFolder(moved) })
    expect(await readdir(join(base, 'other'))).toEqual([])
    expect(await readdir(docFolder)).toEqual(['note.md'])
  })

  it('moves it into a project, and Undo brings it back out', async () => {
    const project = join(base, 'proj')
    await mkdir(project)
    projectPaths = [project]
    invalidateAuthorizedRootsCache()
    const moved = join(project, 'note.md')

    await call('fs:rename', { oldPath: note, newPath: moved, access: documentFolder(note) })
    expect(await readdir(project)).toEqual(['note.md'])

    await call('fs:rename', { oldPath: moved, newPath: note, access: documentFolder(moved) })
    expect(await readdir(project)).toEqual([])
    expect(await readdir(docFolder)).toEqual(['note.md'])
  })

  it('moves it into a subfolder, and Undo brings it back', async () => {
    await mkdir(join(docFolder, 'archive'))
    const moved = join(docFolder, 'archive', 'note.md')

    await call('fs:rename', { oldPath: note, newPath: moved, access: documentFolder(note) })
    expect(await readdir(join(docFolder, 'archive'))).toEqual(['note.md'])

    await call('fs:rename', { oldPath: moved, newPath: note, access: documentFolder(moved) })
    expect(await readdir(join(docFolder, 'archive'))).toEqual([])
    expect((await readdir(docFolder)).sort()).toEqual(['archive', 'note.md'])
  })
})

describe('inserting an image into a document the user opened outside every project', () => {
  it('copies the image into the document folder', async () => {
    const outcome = await call('fs:importExternalPaths', {
      sourcePaths: [join(base, 'shot.png')],
      destDir: docFolder,
      access: documentFolder(note)
    })

    expect(outcome).toMatchObject({ results: [{ status: 'imported' }] })
    expect((await readdir(docFolder)).sort()).toEqual(['note.md', 'shot.png'])
  })

  it('copies the image into a subfolder of the document folder', async () => {
    await mkdir(join(docFolder, 'images'))

    await call('fs:importExternalPaths', {
      sourcePaths: [join(base, 'shot.png')],
      destDir: join(docFolder, 'images'),
      access: documentFolder(note)
    })

    expect(await readdir(join(docFolder, 'images'))).toEqual(['shot.png'])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses an import through a linked subfolder that leads out',
    async () => {
      await mkdir(join(base, 'elsewhere'))
      await symlink(join(base, 'elsewhere'), join(docFolder, 'linked'))

      expect(
        await settles(
          call('fs:importExternalPaths', {
            sourcePaths: [join(base, 'shot.png')],
            destDir: join(docFolder, 'linked'),
            access: documentFolder(note)
          })
        )
      ).toBe('denied')
      expect(await readdir(join(base, 'elsewhere'))).toEqual([])
    }
  )

  it('refuses the parent folder, and any outside folder without access', async () => {
    const importInto = (destDir: string, access?: unknown) =>
      settles(
        call('fs:importExternalPaths', {
          sourcePaths: [join(base, 'shot.png')],
          destDir,
          access
        })
      )

    expect(await importInto(base, documentFolder(note))).toBe('denied')
    expect(await importInto(docFolder)).toBe('denied')
    expect(await readdir(docFolder)).toEqual(['note.md'])
  })
})

describe('a project file opened by its full path', () => {
  it('renames into a subfolder of the project, which the project check allows', async () => {
    const project = join(base, 'project')
    await mkdir(join(project, 'docs', 'old'), { recursive: true })
    await writeFile(join(project, 'docs', 'plan.md'), '# plan\n')
    projectPaths = [project]
    invalidateAuthorizedRootsCache()
    const plan = join(project, 'docs', 'plan.md')

    await call('fs:rename', {
      oldPath: plan,
      newPath: join(project, 'docs', 'old', 'plan.md'),
      access: documentFolder(plan)
    })

    expect(await readdir(join(project, 'docs', 'old'))).toEqual(['plan.md'])
  })

  it('renames into another folder of the same project, as with no declared access', async () => {
    const project = join(base, 'project')
    await mkdir(join(project, 'docs'), { recursive: true })
    await mkdir(join(project, 'archive'))
    await writeFile(join(project, 'docs', 'plan.md'), '# plan\n')
    projectPaths = [project]
    invalidateAuthorizedRootsCache()
    const plan = join(project, 'docs', 'plan.md')

    await call('fs:rename', {
      oldPath: plan,
      newPath: join(project, 'archive', 'plan.md'),
      access: documentFolder(plan)
    })

    expect(await readdir(join(project, 'archive'))).toEqual(['plan.md'])
    expect(await readdir(join(project, 'docs'))).toEqual([])
  })

  it('moves out of the project, and Undo brings it back in', async () => {
    const project = join(base, 'project')
    await mkdir(join(project, 'docs'), { recursive: true })
    await writeFile(join(project, 'docs', 'plan.md'), '# plan\n')
    projectPaths = [project]
    invalidateAuthorizedRootsCache()
    const plan = join(project, 'docs', 'plan.md')
    const moved = join(docFolder, 'plan.md')

    await call('fs:rename', { oldPath: plan, newPath: moved, access: documentFolder(plan) })
    expect((await readdir(docFolder)).sort()).toEqual(['note.md', 'plan.md'])

    await call('fs:rename', { oldPath: moved, newPath: plan, access: documentFolder(moved) })
    expect(await readdir(join(project, 'docs'))).toEqual(['plan.md'])
    expect(await readdir(docFolder)).toEqual(['note.md'])
  })

  it('never moves another project file out by naming the opened document', async () => {
    const project = join(base, 'project')
    await mkdir(project)
    await writeFile(join(project, 'secret.md'), 'secret')
    projectPaths = [project]
    invalidateAuthorizedRootsCache()

    expect(
      await settles(
        call('fs:rename', {
          oldPath: join(project, 'secret.md'),
          newPath: join(docFolder, 'secret.md'),
          access: documentFolder(note)
        })
      )
    ).toBe('denied')
    expect(await readdir(project)).toEqual(['secret.md'])
  })
})

describe('an SSH rename', () => {
  it('goes to the remote host as before, whatever access it declares', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    registerSshFilesystemProvider('ssh-1', { renameNoClobber } as never)
    try {
      await call('fs:rename', {
        oldPath: note,
        newPath: join(base, 'note.md'),
        access: documentFolder(note),
        connectionId: 'ssh-1',
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 0
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(renameNoClobber).toHaveBeenCalledWith(note, join(base, 'note.md'))
    expect(await readdir(docFolder)).toEqual(['note.md'])
  })
})

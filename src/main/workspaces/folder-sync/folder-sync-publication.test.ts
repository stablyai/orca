import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolderSyncManifest } from './folder-sync-manifest'
import { planFolderSync, type FolderSyncPair } from './folder-sync-plan'
import { publishFolderSyncChange } from './folder-sync-publication'

const stage = '.orca-folder-sync-10000000-0000-4000-a000-000000000001'

describe('folder project synchronization', () => {
  let root: string
  let local: string
  let remote: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-folder-sync-'))
    local = join(root, 'local')
    remote = join(root, 'remote')
    await Promise.all([mkdir(local), mkdir(remote)])
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  async function snapshot(): Promise<FolderSyncPair> {
    return Promise.all([scanFolderSyncManifest(local), scanFolderSyncManifest(remote)])
  }

  it('mirrors changes to either side and leaves divergent files in place', async () => {
    const files = ['local.txt', 'remote.txt', 'divergent.txt', 'removed.txt']
    await Promise.all(
      [local, remote].flatMap((path) => files.map((file) => writeFile(join(path, file), 'old')))
    )
    const baseline = await snapshot()
    await Promise.all([
      writeFile(join(local, 'local.txt'), 'changed locally'),
      writeFile(join(remote, 'remote.txt'), 'changed remotely'),
      writeFile(join(local, 'divergent.txt'), 'local edit'),
      writeFile(join(remote, 'divergent.txt'), 'remote edit'),
      rm(join(remote, 'removed.txt'))
    ])
    const { changes, conflicts } = planFolderSync(baseline, await snapshot())

    for (const change of changes) {
      const [from, to] = change.from === 0 ? [local, remote] : [remote, local]
      if (change.entry?.kind === 'file') {
        await writeFile(join(to, stage), await readFile(join(from, change.path)))
      }
      await publishFolderSyncChange(to, { ...change, stage: change.entry ? stage : undefined })
    }

    expect(conflicts).toEqual(['divergent.txt'])
    expect(await readFile(join(remote, 'local.txt'), 'utf8')).toBe('changed locally')
    expect(await readFile(join(local, 'remote.txt'), 'utf8')).toBe('changed remotely')
    expect(await readFile(join(local, 'divergent.txt'), 'utf8')).toBe('local edit')
    expect(await readFile(join(remote, 'divergent.txt'), 'utf8')).toBe('remote edit')
    await expect(readFile(join(local, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not copy unchanged local content when the initial server folder is empty', async () => {
    await writeFile(join(local, 'existing.txt'), 'keep local')
    const baseline = await snapshot()
    await writeFile(join(remote, 'new.txt'), 'from the server')
    const { changes } = planFolderSync(baseline, await snapshot())

    expect(changes.map(({ path, from }) => ({ path, from }))).toEqual([
      { path: 'new.txt', from: 1 }
    ])
  })

  it('creates missing parents without overwriting local files from before empty-folder setup', async () => {
    await mkdir(join(local, 'notes'))
    await writeFile(join(local, 'notes', 'draft.txt'), 'before')
    await writeFile(join(local, 'independent.txt'), 'local original')
    const baseline = await snapshot()
    await writeFile(join(local, 'notes', 'draft.txt'), 'edited')
    await writeFile(join(remote, 'independent.txt'), 'server original')

    const { changes, conflicts } = planFolderSync(baseline, await snapshot())

    expect(changes.map(({ path, from }) => ({ path, from }))).toEqual([
      { path: 'notes', from: 0 },
      { path: 'notes/draft.txt', from: 0 }
    ])
    expect(conflicts).toEqual(['independent.txt'])
  })

  it('restores a destination file changed after its removal was planned', async () => {
    await writeFile(join(local, 'edited.txt'), 'old')
    await writeFile(join(remote, 'edited.txt'), 'old')
    const baseline = await snapshot()
    await rm(join(local, 'edited.txt'))
    const { changes } = planFolderSync(baseline, await snapshot())
    await writeFile(join(remote, 'edited.txt'), 'concurrent edit')

    expect(changes).toHaveLength(1)
    await expect(publishFolderSyncChange(remote, changes[0]!)).rejects.toThrow()
    expect(await readFile(join(remote, 'edited.txt'), 'utf8')).toBe('concurrent edit')
  })

  it('refuses to follow a linked destination directory outside the project', async () => {
    await writeFile(join(local, 'data.txt'), 'local data')
    const [, entry] = (await scanFolderSyncManifest(local))[0]!
    await writeFile(join(remote, stage), 'local data')
    await symlink(local, join(remote, 'linked'), 'junction')

    await expect(
      publishFolderSyncChange(remote, { path: 'linked/other.txt', entry, stage })
    ).rejects.toThrow('Folder sync path changed')
    await expect(readFile(join(local, 'other.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

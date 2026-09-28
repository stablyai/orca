import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanLooseObjects } from '../../shared/loose-object-scan'
import { createObjectPackHousekeepingTask } from './object-pack-housekeeping-maintenance-task'
import { createPackLooseObjectsMaintenanceTask } from './pack-loose-objects-maintenance-task'

const NO_ABORT = new AbortController().signal
const NO_LOCK = { setHeld: () => {} }
const DAY_MS = 24 * 60 * 60_000
const roots: string[] = []

function git(cwd: string, args: string[], stdin?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(stdin === undefined ? {} : { input: stdin }),
    maxBuffer: 64 * 1024 * 1024
  }).trim()
}

type Repo = { repoPath: string; packDir: string; unreachable: string[] }

/** A repository holding `count` young unreachable blobs, all loose. */
async function createRepo(count: number): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'orca-object-pack-housekeeping-'))
  roots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'file.txt'), 'one\n')
  git(repoPath, ['add', 'file.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  // Packed up front, so the only loose objects are the ones the test counts.
  git(repoPath, ['repack', '-a', '-d', '-q'])
  const source = join(root, 'blobs')
  await mkdir(source)
  const paths: string[] = []
  for (let index = 0; index < count; index += 1) {
    paths.push(join(source, `blob-${index}`))
    await writeFile(paths[index], `unreachable ${index}\n`)
  }
  const unreachable = git(
    repoPath,
    ['hash-object', '-w', '--stdin-paths'],
    `${paths.join('\n')}\n`
  ).split('\n')
  return { repoPath, packDir: join(repoPath, '.git', 'objects', 'pack'), unreachable }
}

function tasksFor(repoPath: string, batchSize = 10_000) {
  const args = { repoPath, resolveCommonDir: async () => join(repoPath, '.git') }
  return {
    objects: createPackLooseObjectsMaintenanceTask({ ...args, threshold: 1, batchSize }),
    housekeeping: createObjectPackHousekeepingTask(args)
  }
}

async function looseObjectCount(repoPath: string): Promise<number> {
  return (await scanLooseObjects(join(repoPath, '.git', 'objects'), 1_000_000)).count
}

async function packNames(packDir: string, extension: '.pack' | '.keep'): Promise<string[]> {
  return (await readdir(packDir))
    .filter((name) => name.startsWith('loose-') && name.endsWith(extension))
    .sort()
}

function missingObjects(repoPath: string, ids: string[]): string[] {
  const output = git(repoPath, ['cat-file', '--batch-check'], `${ids.join('\n')}\n`)
  return output.split('\n').filter((line) => line.includes('missing'))
}

/** What `gc --auto` runs on a Git without cruft packs, or with them turned off. */
function preCruftRepack(repoPath: string): void {
  git(repoPath, [
    '-c',
    'gc.cruftPacks=false',
    'repack',
    '-d',
    '-l',
    '-A',
    '--unpack-unreachable=2.weeks.ago'
  ])
}

async function packInBatches(repo: Repo, batchSize: number): Promise<void> {
  const { objects } = tasksFor(repo.repoPath, batchSize)
  while ((await looseObjectCount(repo.repoPath)) > 0) {
    await objects.pack(NO_LOCK)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('kept loose-object packs against real Git', () => {
  it('survives a pre-cruft repack without turning loose again', async () => {
    const repo = await createRepo(300)
    await tasksFor(repo.repoPath).objects.pack(NO_LOCK)
    expect(await looseObjectCount(repo.repoPath)).toBe(0)

    preCruftRepack(repo.repoPath)

    expect(await looseObjectCount(repo.repoPath)).toBe(0)
    expect(missingObjects(repo.repoPath, repo.unreachable)).toEqual([])
  })

  it('is what stops the repack: an unkept pack explodes back to loose', async () => {
    // The control for the test above, so it cannot pass for some other reason.
    const repo = await createRepo(300)
    await tasksFor(repo.repoPath).objects.pack(NO_LOCK)
    for (const keep of await packNames(repo.packDir, '.keep')) {
      await rm(join(repo.packDir, keep))
    }

    preCruftRepack(repo.repoPath)

    expect(await looseObjectCount(repo.repoPath)).toBe(300)
  })

  it('merges same-day packs into one kept pack that still holds every object', async () => {
    const repo = await createRepo(300)
    await packInBatches(repo, 100)
    expect(await packNames(repo.packDir, '.keep')).toHaveLength(3)
    const newest = Math.max(
      ...(await Promise.all(
        (await packNames(repo.packDir, '.pack')).map(
          async (name) => (await stat(join(repo.packDir, name))).mtimeMs
        )
      ))
    )
    const { housekeeping } = tasksFor(repo.repoPath)

    await expect(housekeeping.probeBacklog(100, NO_ABORT)).resolves.toMatchObject({ count: 2 })
    await expect(housekeeping.pack(NO_LOCK)).resolves.toEqual({ batchExhausted: false })

    const packs = await packNames(repo.packDir, '.pack')
    expect(packs).toHaveLength(1)
    expect(await packNames(repo.packDir, '.keep')).toEqual([packs[0].replace(/\.pack$/, '.keep')])
    // Aged as its newest member, so no object lives longer than it would have.
    const mergedMtimeMs = (await stat(join(repo.packDir, packs[0]))).mtimeMs
    expect(Math.abs(mergedMtimeMs - newest)).toBeLessThan(1000)
    expect(missingObjects(repo.repoPath, repo.unreachable)).toEqual([])
    await expect(housekeeping.probeBacklog(100, NO_ABORT)).resolves.toMatchObject({ count: 0 })
    preCruftRepack(repo.repoPath)
    expect(await looseObjectCount(repo.repoPath)).toBe(0)
  })

  it('leaves packs from different days apart', async () => {
    const repo = await createRepo(200)
    await packInBatches(repo, 100)
    const [older] = await packNames(repo.packDir, '.pack')
    const threeDaysAgo = (Date.now() - 3 * DAY_MS) / 1000
    await utimes(join(repo.packDir, older), threeDaysAgo, threeDaysAgo)

    await expect(
      tasksFor(repo.repoPath).housekeeping.probeBacklog(100, NO_ABORT)
    ).resolves.toMatchObject({ count: 0 })
  })

  it('merges across days when the user keeps unreachable objects forever', async () => {
    const repo = await createRepo(200)
    await packInBatches(repo, 100)
    const [older] = await packNames(repo.packDir, '.pack')
    const threeDaysAgo = (Date.now() - 3 * DAY_MS) / 1000
    await utimes(join(repo.packDir, older), threeDaysAgo, threeDaysAgo)
    git(repo.repoPath, ['config', 'gc.pruneExpire', 'never'])
    const { housekeeping } = tasksFor(repo.repoPath)

    await expect(housekeeping.probeBacklog(100, NO_ABORT)).resolves.toMatchObject({ count: 1 })
    await housekeeping.pack(NO_LOCK)

    expect(await packNames(repo.packDir, '.keep')).toHaveLength(1)
    expect(missingObjects(repo.repoPath, repo.unreachable)).toEqual([])
  })

  it('hands a pack back to Git once it is as old as gc.pruneExpire', async () => {
    const repo = await createRepo(50)
    await tasksFor(repo.repoPath).objects.pack(NO_LOCK)
    git(repo.repoPath, ['config', 'gc.pruneExpire', 'now'])
    const { housekeeping } = tasksFor(repo.repoPath)

    await expect(housekeeping.probeBacklog(100, NO_ABORT)).resolves.toMatchObject({ count: 1 })
    await housekeeping.pack(NO_LOCK)

    expect(await packNames(repo.packDir, '.keep')).toEqual([])
    expect(await packNames(repo.packDir, '.pack')).toHaveLength(1)
    // Released, the pack is Git's again: its own prune drops what is unreachable.
    git(repo.repoPath, ['gc', '--quiet', '--prune=now'])
    expect(missingObjects(repo.repoPath, repo.unreachable)).toHaveLength(50)
  })

  it('never releases a keep it did not write', async () => {
    const repo = await createRepo(50)
    await tasksFor(repo.repoPath).objects.pack(NO_LOCK)
    const [keep] = await packNames(repo.packDir, '.keep')
    await writeFile(join(repo.packDir, keep), '')
    git(repo.repoPath, ['config', 'gc.pruneExpire', 'now'])

    await tasksFor(repo.repoPath).housekeeping.pack(NO_LOCK)

    expect(await packNames(repo.packDir, '.keep')).toEqual([keep])
  })
})

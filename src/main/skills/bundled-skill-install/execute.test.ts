import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSkillInstallLock, skillInstallLockPath } from '../skill-install-lock'
import { nativeBundledSkillFilesystem, type BundledSkillFilesystem } from './filesystem'
import { installBundledSkills, previewBundledSkillInstall } from './service'
import {
  linkDirectory,
  leftoverSiblings,
  makeSkillHome,
  NAME,
  NEW_TEXT,
  OLD_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy,
  type SkillHome
} from './skill-home.test-support'

afterEach(async () => {
  await removeSkillHomes()
})

async function npxShared(home: SkillHome, agents: ('claude' | 'cursor')[] = ['claude']) {
  await writeCopy(home.shared, OLD_TEXT)
  await mkdir(dirname(home.claude), { recursive: true })
  await linkDirectory(home.shared, home.claude)
  return serviceInput(home, { agents })
}

/** Dies like a killed process: from the `crashAt`-th rename or move on, every write throws, rollback included. */
function crashingFilesystem(crashAt: number): BundledSkillFilesystem {
  let renames = 0
  let dead = false
  const die = () => {
    dead = true
    throw Object.assign(new Error('crashed'), { code: 'ECRASH' })
  }
  // Moves into backups count as renames: they are the same step of a swap.
  const step = () => {
    renames += 1
    if (dead || renames >= crashAt) {
      die()
    }
  }
  const guard =
    <A extends unknown[]>(write: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      if (dead) {
        die()
      }
      await write(...args)
    }
  return {
    ...nativeBundledSkillFilesystem,
    writeFolder: guard(nativeBundledSkillFilesystem.writeFolder),
    ensureDirectory: guard(nativeBundledSkillFilesystem.ensureDirectory),
    remove: guard(nativeBundledSkillFilesystem.remove),
    createLink: guard(nativeBundledSkillFilesystem.createLink),
    rename: async (source, target) => {
      step()
      await nativeBundledSkillFilesystem.rename(source, target)
    },
    moveToBackup: async (source, target) => {
      step()
      await nativeBundledSkillFilesystem.moveToBackup(source, target)
    }
  }
}

function sharedOp(plan: Awaited<ReturnType<typeof previewBundledSkillInstall>>) {
  const [op] = plan.skills[0].ops
  return { kind: op.kind, cleanup: op.cleanup.map((cleanup) => cleanup.action) }
}

async function crashThenRecover(home: SkillHome, crashAt: number, force: string[] = []) {
  const input = { ...(await npxShared(home)), force }
  const plan = await previewBundledSkillInstall(input)
  const crashed = await installBundledSkills(
    { ...input, filesystem: crashingFilesystem(crashAt) },
    plan.planDigest
  )
  expect(crashed.skills[0].ops[0].status).toBe('failed')
  return {
    input: { ...input, force: [] },
    recovery: await previewBundledSkillInstall({ ...input, force: [] })
  }
}

describe('interrupted swaps', () => {
  it('drops a stray stage left before the old copy moved', async () => {
    const home = await makeSkillHome()
    const { input, recovery } = await crashThenRecover(home, 1)
    expect(sharedOp(recovery)).toEqual({ kind: 'update', cleanup: ['delete'] })
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('restores the old copy when the crash left the target missing', async () => {
    const home = await makeSkillHome()
    const { input, recovery } = await crashThenRecover(home, 2)
    expect(await snapshot(home.shared)).toBe('missing')
    expect(sharedOp(recovery)).toEqual({ kind: 'restore', cleanup: ['delete'] })
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${OLD_TEXT}`)
    expect(sharedOp(await previewBundledSkillInstall(input)).kind).toBe('update')
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('deletes the released old copy once the new one is in', async () => {
    const home = await makeSkillHome()
    // The third step is the old copy's delete, which goes through `remove`, not `rename`.
    const input = await npxShared(home)
    const plan = await previewBundledSkillInstall(input)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      remove: async () => {
        throw Object.assign(new Error('crashed'), { code: 'ECRASH' })
      }
    }
    await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    expect(sharedOp(await previewBundledSkillInstall(input))).toEqual({
      kind: 'keep',
      cleanup: ['delete']
    })
    await previewAndInstall(input)
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('never loses the user’s copy when Replace dies after the backup move', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, `---\nname: ${NAME}\n---\nmine\n`)
    const input = serviceInput(home, { force: [home.shared] })
    const plan = await previewBundledSkillInstall(input)
    await installBundledSkills({ ...input, filesystem: crashingFilesystem(2) }, plan.planDigest)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const [backup] = await readdir(backups)
    expect(await readFile(join(backups, backup, 'SKILL.md'), 'utf8')).toContain('mine')
    expect(sharedOp(await previewBundledSkillInstall({ ...input, force: [] }))).toEqual({
      kind: 'write',
      cleanup: ['delete']
    })
  })
})

describe('the disk changing under a plan', () => {
  it.each([
    ['edited', 'notes.txt'],
    ['edited', join('scripts', 'run.sh')],
    ['foreign', 'notes.txt'],
    ['foreign', join('scripts', 'run.sh')]
  ])('does not replace a %s copy whose %s changed after preview', async (kind, auxiliary) => {
    const home = await makeSkillHome()
    const text = kind === 'edited' ? `---\nname: ${NAME}\n---\nmine\n` : 'another skill\n'
    await writeCopy(home.shared, text)
    const auxiliaryPath = join(home.shared, auxiliary)
    await mkdir(dirname(auxiliaryPath), { recursive: true })
    await writeFile(auxiliaryPath, 'before\n')
    const input = serviceInput(home, { agents: [], force: [home.shared] })
    const plan = await previewBundledSkillInstall(input)
    expect(plan.skills[0].ops[0].kind).toBe('replace')

    await writeFile(auxiliaryPath, 'after\n')
    const result = await installBundledSkills(input, plan.planDigest)

    expect(result.skills).toEqual([{ name: NAME, status: 'changed', ops: [] }])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(text)
    expect(await readFile(auxiliaryPath, 'utf8')).toBe('after\n')
    expect(
      await readdir(join(home.home, '.agents', '.orca-skill-backups')).catch(() => [])
    ).toEqual([])
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('rechecks auxiliary content immediately before moving a replacement into backups', async () => {
    const home = await makeSkillHome()
    const text = `---\nname: ${NAME}\n---\nmine\n`
    await writeCopy(home.shared, text)
    const auxiliaryPath = join(home.shared, 'scripts', 'run.sh')
    await mkdir(dirname(auxiliaryPath), { recursive: true })
    await writeFile(auxiliaryPath, 'before\n')
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      ensureDirectory: async (path) => {
        await nativeBundledSkillFilesystem.ensureDirectory(path)
        await writeFile(auxiliaryPath, 'raced\n')
      }
    }
    const input = serviceInput(home, { agents: [], force: [home.shared], filesystem })
    const plan = await previewBundledSkillInstall(input)

    const result = await installBundledSkills(input, plan.planDigest)

    expect(result.skills[0].ops.map((op) => [op.kind, op.status])).toEqual([['replace', 'changed']])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(text)
    expect(await readFile(auxiliaryPath, 'utf8')).toBe('raced\n')
    expect(await readdir(join(home.home, '.agents', '.orca-skill-backups'))).toEqual([])
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('writes nothing when the folder changed after the preview', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    const plan = await previewBundledSkillInstall(input)
    await writeFile(join(home.shared, 'SKILL.md'), 'edited meanwhile\n')
    const result = await installBundledSkills(input, plan.planDigest)
    expect(result.skills).toEqual([{ name: NAME, status: 'changed', ops: [] }])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe('edited meanwhile\n')
  })

  it('writes nothing for a digest it did not plan', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    expect((await installBundledSkills(input, 'not-the-plan')).skills[0].status).toBe('changed')
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${OLD_TEXT}`)
  })

  it('stops an op whose target changed after the re-plan and skips its links', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home, ['claude', 'cursor'])
    const plan = await previewBundledSkillInstall(input)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      writeFolder: async (path, files) => {
        await nativeBundledSkillFilesystem.writeFolder(path, files)
        await writeFile(join(home.shared, 'SKILL.md'), 'raced\n')
      }
    }
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    expect(result.skills[0].ops.map((op) => [op.kind, op.status])).toEqual([
      ['update', 'changed'],
      ['keep', 'done'],
      ['link', 'skipped']
    ])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe('raced\n')
    expect(await snapshot(home.cursor)).toBe('missing')
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('backs up an old copy a racing writer changed instead of deleting it', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    const plan = await previewBundledSkillInstall(input)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        await nativeBundledSkillFilesystem.rename(source, target)
        if (target.includes('.orca-old-')) {
          await writeFile(join(target, 'SKILL.md'), 'raced\n')
        }
      }
    }
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    const backup = result.skills[0].ops[0].backupPath ?? ''
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe('raced\n')
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
  })

  it('reports busy without writing while another install holds a lock', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    const plan = await previewBundledSkillInstall(input)
    const release = await acquireSkillInstallLock({
      path: skillInstallLockPath(home.state, home.claude)
    })
    try {
      const result = await installBundledSkills(input, plan.planDigest)
      expect(result.skills).toEqual([{ name: NAME, status: 'busy', ops: [] }])
    } finally {
      await release()
    }
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${OLD_TEXT}`)
  })
})

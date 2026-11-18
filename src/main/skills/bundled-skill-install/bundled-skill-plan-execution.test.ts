import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from './bundled-skill-filesystem'
import { installBundledSkills, previewBundledSkillInstall } from './bundled-skill-installation'
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
} from './testing/bundled-skill-home'

afterEach(async () => {
  await removeSkillHomes()
})

async function npxShared(home: SkillHome, agents: ('claude' | 'cursor')[] = ['claude']) {
  await writeCopy(home.shared, OLD_TEXT)
  await mkdir(dirname(home.claude), { recursive: true })
  await linkDirectory(home.shared, home.claude)
  return serviceInput(home, { agents })
}

/** After crashAt, all writes fail, including rollback, to model a killed transaction. */
function crashingFilesystem(crashAt: number): BundledSkillFilesystem {
  let renames = 0
  let dead = false
  const die = () => {
    dead = true
    throw Object.assign(new Error('crashed'), { code: 'ECRASH' })
  }
  // Backup moves are swap steps too.
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
    writeFile: guard(nativeBundledSkillFilesystem.writeFile),
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
    expect(sharedOp(recovery)).toEqual({ kind: 'update', cleanup: ['delete', 'delete'] })
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it.each([
    ['writing the stage', 'write'],
    ['before the rename', 'rename'],
    ['after the rename', 'after']
  ] as const)(
    'recovers an update that died %s and keeps the files beside SKILL.md',
    async (_, at) => {
      const home = await makeSkillHome()
      const input = await npxShared(home)
      const sidecar = join(home.shared, 'agents', 'openai.yaml')
      await mkdir(dirname(sidecar))
      await writeFile(sidecar, 'mine\n')
      const plan = await previewBundledSkillInstall(input)
      expect(sharedOp(plan)).toEqual({ kind: 'update', cleanup: [] })
      let dead = false
      const die = () => {
        dead = true
        throw Object.assign(new Error('crashed'), { code: 'ECRASH' })
      }
      const filesystem: BundledSkillFilesystem = {
        ...nativeBundledSkillFilesystem,
        writeFile: async (path, text) => {
          if (at !== 'write') {
            return nativeBundledSkillFilesystem.writeFile(path, text)
          }
          // A partial stage, as when the process dies mid-write.
          await nativeBundledSkillFilesystem.writeFile(path, text.slice(0, 5))
          die()
        },
        rename: async (source, target) => {
          if (at === 'rename') {
            die()
          }
          await nativeBundledSkillFilesystem.rename(source, target)
          die()
        },
        remove: async (path) => (dead ? die() : nativeBundledSkillFilesystem.remove(path))
      }
      await installBundledSkills({ ...input, filesystem }, plan.planDigest)
      expect(await readFile(sidecar, 'utf8')).toBe('mine\n')

      // The stage, then the hard link to the replaced shipped SKILL.md, are Orca's to delete.
      const recovery = {
        write: { kind: 'update', cleanup: ['delete'] },
        rename: { kind: 'update', cleanup: ['delete', 'delete'] },
        after: { kind: 'keep', cleanup: ['delete'] }
      }[at]
      expect(sharedOp(await previewBundledSkillInstall(input))).toEqual(recovery)
      await previewAndInstall(input)
      expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
      expect((await readdir(home.shared)).sort()).toEqual(['SKILL.md', 'agents'])
      expect(await readFile(sidecar, 'utf8')).toBe('mine\n')
    }
  )

  it('cleans a stray stage beside a SKILL.md the user has since edited', async () => {
    const home = await makeSkillHome()
    const edited = `---\nname: ${NAME}\n---\nmine\n`
    await writeCopy(home.shared, edited)
    const stray = join(home.shared, '.SKILL.md.orca-stage-0b8f4a52-6c1e-4d7a-9f3b-2a5c8e1d7f60')
    await writeFile(stray, 'partial')
    const input = serviceInput(home, { agents: [] })
    expect(sharedOp(await previewBundledSkillInstall(input))).toEqual({
      kind: 'leave',
      cleanup: ['delete']
    })
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${edited}`)
  })

  it('restores an older build’s moved-aside copy when the target is missing', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    await rename(home.shared, join(dirname(home.shared), `.${NAME}.orca-old-1`))
    expect(sharedOp(await previewBundledSkillInstall(input))).toEqual({
      kind: 'restore',
      cleanup: []
    })
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${OLD_TEXT}`)
    await previewAndInstall(input)
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })

  it('deletes an older build’s released old copy but backs one up with other files', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    await writeCopy(join(dirname(home.shared), `.${NAME}.orca-old-1`), OLD_TEXT)
    await writeCopy(join(dirname(home.shared), `.${NAME}.orca-old-2`), OLD_TEXT, {
      'notes.md': 'mine'
    })
    expect(sharedOp(await previewBundledSkillInstall(input))).toEqual({
      kind: 'update',
      cleanup: ['delete', 'backup']
    })
    await previewAndInstall(input)
    expect(await leftoverSiblings(home.shared)).toEqual([])
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const [kept] = await readdir(backups)
    expect(await readFile(join(backups, kept, 'notes.md'), 'utf8')).toBe('mine')
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
      writeFile: async (path, text) => {
        await nativeBundledSkillFilesystem.writeFile(path, text)
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
    expect(await readdir(home.shared)).toEqual(['SKILL.md'])
  })

  it('updates a forced copy with extra files and a stray stage', async () => {
    const home = await makeSkillHome()
    const input = { ...(await npxShared(home)), force: [home.shared, home.claude] }
    const sidecar = join(home.shared, 'agents', 'openai.yaml')
    await mkdir(dirname(sidecar))
    await writeFile(sidecar, 'mine\n')
    await writeFile(
      join(home.shared, '.SKILL.md.orca-stage-0b8f4a52-6c1e-4d7a-9f3b-2a5c8e1d7f60'),
      'x'
    )
    const { result } = await previewAndInstall(input)
    expect(result.skills[0].ops.map((op) => [op.kind, op.status])).toEqual([
      ['update', 'done'],
      ['keep', 'done']
    ])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect((await readdir(home.shared)).sort()).toEqual(['SKILL.md', 'agents'])
  })

  it('backs up an edit that lands in the replaced SKILL.md instead of losing it', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    const plan = await previewBundledSkillInstall(input)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        await nativeBundledSkillFilesystem.rename(source, target)
        // An editor holding the old SKILL.md open saves after the rename.
        const old = (await readdir(home.shared)).find((name) => name.includes('.orca-old-')) ?? ''
        await writeFile(join(home.shared, old), 'raced\n')
      }
    }
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    const backup = result.skills[0].ops[0].backupPath ?? ''
    expect(await readFile(backup, 'utf8')).toBe('raced\n')
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
  })

  it('keeps an edit when a rename reports failure after it committed', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    const plan = await previewBundledSkillInstall(input)
    const oldName = async () =>
      (await readdir(home.shared)).find((name) => name.includes('.orca-old-')) ?? ''
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        await nativeBundledSkillFilesystem.rename(source, target)
        await writeFile(join(home.shared, await oldName()), 'raced\n')
        throw Object.assign(new Error('lost reply'), { code: 'EIO' })
      }
    }
    await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(sharedOp(await previewBundledSkillInstall(input))).toEqual({
      kind: 'keep',
      cleanup: ['backup']
    })
    await previewAndInstall(input)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const [kept] = await readdir(backups)
    expect(await readFile(join(backups, kept, 'SKILL.md'), 'utf8')).toBe('raced\n')
  })

  it('backs up an older build’s old copy holding an unsettled replaced SKILL.md', async () => {
    const home = await makeSkillHome()
    const input = await npxShared(home)
    const legacy = join(dirname(home.shared), `.${NAME}.orca-old-1`)
    await writeCopy(legacy, OLD_TEXT, {
      '.SKILL.md.orca-old-0b8f4a52-6c1e-4d7a-9f3b-2a5c8e1d7f60': 'mine\n'
    })
    expect(sharedOp(await previewBundledSkillInstall(input))).toEqual({
      kind: 'update',
      cleanup: ['backup']
    })
  })
})

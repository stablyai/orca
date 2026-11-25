import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillNudgeEntries } from '../../../shared/skills/bundled/bundled-skill-summary'

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
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy,
  type SkillHome
} from './testing/bundled-skill-home'
import { lateEditingFilesystem } from './testing/late-editing-filesystem'

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
    ensureDirectory: guard(nativeBundledSkillFilesystem.ensureDirectory),
    remove: guard(nativeBundledSkillFilesystem.remove),
    createLink: guard(nativeBundledSkillFilesystem.createLink),
    rename: async (source, target) => {
      step()
      await nativeBundledSkillFilesystem.rename(source, target)
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
    // The old copy is removed on the third step; inject failure in remove, not rename.
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
    const result = await installBundledSkills(
      { ...input, filesystem: crashingFilesystem(2) },
      plan.planDigest
    )
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const [backup] = await readdir(backups)
    expect(result.skills[0].ops[0]).toMatchObject({
      status: 'failed',
      error: 'ECRASH',
      backupPath: join(backups, backup)
    })
    expect(await readFile(join(backups, backup, 'SKILL.md'), 'utf8')).toContain('mine')
    expect(sharedOp(await previewBundledSkillInstall({ ...input, force: [] }))).toEqual({
      kind: 'write',
      cleanup: ['delete']
    })
  })

  it('reports the original backup if a writer occupies the target before Replace finishes', async () => {
    const home = await makeSkillHome()
    const edited = `${OLD_TEXT}Local edit\n`
    await writeCopy(home.shared, edited)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        if (target === home.shared && source.includes('.orca-stage-')) {
          await mkdir(target)
          throw Object.assign(new Error('new occupant'), { code: 'EEXIST' })
        }
        return nativeBundledSkillFilesystem.rename(source, target)
      }
    }
    const input = serviceInput(home, { agents: [], force: [home.shared], filesystem })
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills(input, plan.planDigest)
    const failed = result.skills[0].ops[0]
    expect(failed).toMatchObject({ status: 'failed', error: 'EEXIST' })
    expect(await readFile(join(failed.backupPath ?? '', 'SKILL.md'), 'utf8')).toBe(edited)
    expect(await readdir(home.shared)).toEqual([])
    expect(await leftoverSiblings(home.shared)).toEqual([])
  })
  it('puts the original back with its own mode when Replace fails on a free target', async () => {
    const home = await makeSkillHome()
    const edited = `${OLD_TEXT}Local edit\n`
    await writeCopy(home.shared, edited, { 'notes.md': 'user payload' })
    const modeBefore = (await stat(home.shared)).mode
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        if (target === home.shared && source.includes('.orca-stage-')) {
          throw Object.assign(new Error('placement failed'), { code: 'EIO' })
        }
        return nativeBundledSkillFilesystem.rename(source, target)
      }
    }
    const input = serviceInput(home, { agents: [], force: [home.shared] })
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    expect(result.skills[0].ops[0]).toEqual({
      path: home.shared,
      kind: 'replace',
      status: 'failed',
      error: 'EIO'
    })
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(edited)
    expect(await readFile(join(home.shared, 'notes.md'), 'utf8')).toBe('user payload')
    expect((await stat(home.shared)).mode).toBe(modeBefore)
    expect(await readdir(join(home.home, '.agents', '.orca-skill-backups'))).toEqual([])
    expect(await leftoverSiblings(home.shared)).toEqual([])
    expect((await previewBundledSkillInstall(input)).planDigest).toBe(plan.planDigest)
  })

  it('keeps a finished Replace when the backup cannot be made private', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, `${OLD_TEXT}Local edit\n`)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      privatizeBackup: async () => {
        throw Object.assign(new Error('chmod failed'), { code: 'EPERM' })
      }
    }
    const input = serviceInput(home, { agents: [], force: [home.shared] })
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    const done = result.skills[0].ops[0]
    expect(done.status).toBe('done')
    expect(done.backupPaths).toEqual([done.backupPath])
    expect(await readFile(join(done.backupPath ?? '', 'SKILL.md'), 'utf8')).toBe(
      `${OLD_TEXT}Local edit\n`
    )
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
  })
})

describe('cross-drive backup refusal', () => {
  it.each(['files', 'link'] as const)(
    'keeps a refused %s replacement eligible for retry',
    async (content) => {
      const home = await makeSkillHome()
      const target = content === 'files' ? home.shared : home.claude
      if (content === 'link') {
        await writeCopy(home.shared, NEW_TEXT)
      }
      const edited = `${OLD_TEXT}Local edit\n`
      await writeCopy(target, edited, { 'notes.md': 'user payload' })
      const backups = join(home.home, '.agents', '.orca-skill-backups')
      let refused = false
      let treeReadsAfterRefusal = 0
      const countRefusedTreeRead = (path: string) => {
        if (refused && path.startsWith(target)) {
          treeReadsAfterRefusal += 1
        }
      }
      const filesystem: BundledSkillFilesystem = {
        ...nativeBundledSkillFilesystem,
        rename: async (source, destination) => {
          if (dirname(destination) === backups) {
            refused = true
            throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
          }
          return nativeBundledSkillFilesystem.rename(source, destination)
        },
        hashFile: async (path) => {
          countRefusedTreeRead(path)
          return nativeBundledSkillFilesystem.hashFile?.(path) ?? null
        },
        readFile: async (path, maxBytes) => {
          countRefusedTreeRead(path)
          return nativeBundledSkillFilesystem.readFile(path, maxBytes)
        },
        listEntries: async (directory) => {
          countRefusedTreeRead(directory)
          return nativeBundledSkillFilesystem.listEntries(directory)
        }
      }
      const input = serviceInput(home, { agents: ['claude'], force: [target] })
      const plan = await previewBundledSkillInstall(input)
      expect(plan.skills[0].ops.find((op) => op.path === target)?.content).toBe(content)
      const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)

      expect(result.skills[0].ops.find((op) => op.path === target)).toEqual({
        path: target,
        kind: 'replace',
        status: 'failed',
        error: 'EXDEV',
        backupRefusal: { path: target, source: 'in-place' }
      })
      if (content === 'files') {
        expect(result.skills[0].ops.find((op) => op.path === home.claude)?.status).toBe('skipped')
        expect(await snapshot(join(home.home, '.agents', '.orca-skill-digests'))).toBe('missing')
      }
      expect(treeReadsAfterRefusal).toBe(0)
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(edited)
      expect(await readFile(join(target, 'notes.md'), 'utf8')).toBe('user payload')
      expect(await readdir(backups)).toEqual([])
      expect(await leftoverSiblings(target)).toEqual([])
      expect((await previewBundledSkillInstall(input)).planDigest).toBe(plan.planDigest)
      expect(
        bundledSkillNudgeEntries(await previewBundledSkillInstall({ ...input, force: [] }))
      ).toHaveLength(1)

      const retried = await installBundledSkills(input, plan.planDigest)
      const done = retried.skills[0].ops.find((op) => op.path === target)
      expect(done?.status).toBe('done')
      expect(await readFile(join(done?.backupPath ?? '', 'notes.md'), 'utf8')).toBe('user payload')
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    }
  )

  it('detects a write during publication and preserves it through refusal and a fresh recovery plan', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    let oldPath = ''
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        if (dirname(target) === backups) {
          throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
        }
        if (source === home.shared) {
          oldPath = target
        } else if (source.includes('.orca-stage-') && target === home.shared) {
          await writeFile(join(oldPath, 'SKILL.md'), 'edited during publication\n')
        }
        return nativeBundledSkillFilesystem.rename(source, target)
      }
    }
    const input = serviceInput(home, { agents: ['claude'] })
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    expect(result.skills[0].ops).toMatchObject([
      {
        path: home.shared,
        status: 'failed',
        error: 'EXDEV',
        contentApplied: true,
        strandedPath: oldPath,
        backupRefusal: { path: oldPath, source: 'moved-aside' }
      },
      { path: home.claude, status: 'done' }
    ])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await readdir(join(home.home, '.agents', '.orca-skill-digests', NAME))).toEqual([
      plan.skills[0].digest
    ])
    expect(await readFile(join(oldPath, 'SKILL.md'), 'utf8')).toBe('edited during publication\n')
    expect(await readdir(backups)).toEqual([])

    const recovery = await previewBundledSkillInstall(input)
    expect(bundledSkillNudgeEntries(recovery)).toHaveLength(1)
    const refusedCleanup = await installBundledSkills({ ...input, filesystem }, recovery.planDigest)
    expect(refusedCleanup.skills[0].ops[0]).toEqual({
      path: home.shared,
      kind: 'keep',
      status: 'failed',
      error: 'EXDEV',
      currentConfirmed: true,
      backupRefusal: { path: oldPath, source: 'leftover' }
    })
    expect((await previewBundledSkillInstall(input)).planDigest).toBe(recovery.planDigest)
    await writeFile(join(oldPath, 'SKILL.md'), 'edited again\n')
    const stale = await installBundledSkills(input, recovery.planDigest)
    expect(stale.skills[0].status).toBe('changed')
    const { result: retried } = await previewAndInstall(input)
    expect(retried.skills[0].ops[0].status).toBe('done')
    const [backup] = await readdir(backups)
    expect(await readFile(join(backups, backup, 'SKILL.md'), 'utf8')).toBe('edited again\n')
  })

  it('keeps a refused forwarded retirement at its recovery path', async () => {
    const home = await makeSkillHome()
    const alias = 'former-skill'
    const former = join(dirname(home.shared), alias)
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(former, OLD_TEXT)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const late = lateEditingFilesystem(backups, former)
    const input = {
      ...serviceInput(home, { agents: ['claude'] }),
      sources: [{ ...NEW_SOURCE, aliases: [alias] }]
    }
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills(
      { ...input, filesystem: late.filesystem },
      plan.planDigest
    )
    const oldPath = late.oldPath()
    expect(result.skills[0].ops).toMatchObject([
      {
        path: home.shared,
        status: 'failed',
        error: 'EXDEV',
        contentApplied: true,
        backupRefusal: { path: oldPath, source: 'moved-aside' }
      },
      { path: home.claude, status: 'done' }
    ])
    expect(result.skills[0].ops[0].backupRefusal?.onlyNotice).toBeUndefined()
    expect(late.readsAfterRefusal()).toBe(0)
    expect(await readFile(join(oldPath, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Late edit\n`)
    expect(await readdir(backups)).toEqual([])
    // The former placement now forwards to the new copy; recovery must still find the edit.
    expect((await lstat(former)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(former, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)

    const recovery = await previewBundledSkillInstall({ ...input, installedOnly: true })
    expect(bundledSkillNudgeEntries(recovery)).toHaveLength(1)
    expect(recovery.skills[0].ops.find((op) => op.path === former)?.cleanup).toMatchObject([
      { path: oldPath, action: 'backup', observed: { treeDigest: expect.any(String) } }
    ])
    await previewAndInstall(input)
    expect(await snapshot(oldPath)).toBe('missing')
    const [backup] = await readdir(backups)
    expect(await readFile(join(backups, backup, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Late edit\n`)
  })

  it.each(['stable', 'changed'] as const)(
    'reports a rechecked keep, not an update, when its forwarded retirement is refused (%s copy)',
    async (kept) => {
      const home = await makeSkillHome()
      const alias = 'former-skill'
      const former = join(dirname(home.shared), alias)
      // A current SKILL.md beside an agent's own file is kept, not swapped, so retiring the former
      // name is the op's only write.
      await writeCopy(home.shared, NEW_TEXT)
      await writeFile(join(home.shared, 'notes.md'), 'agent notes\n')
      await writeCopy(former, OLD_TEXT)
      const backups = join(home.home, '.agents', '.orca-skill-backups')
      // The kept copy can change while its former name is being retired.
      const late = lateEditingFilesystem(backups, former, async () => {
        if (kept === 'changed') {
          await writeFile(join(home.shared, 'SKILL.md'), 'edited during the retirement\n')
        }
      })
      const input = {
        ...serviceInput(home, { agents: ['claude'] }),
        sources: [{ ...NEW_SOURCE, aliases: [alias] }]
      }
      const plan = await previewBundledSkillInstall(input)
      expect(plan.skills[0].ops[0]).toMatchObject({
        path: home.shared,
        kind: 'keep',
        previous: [{ path: former, forward: true }]
      })
      const result = await installBundledSkills(
        { ...input, filesystem: late.filesystem },
        plan.planDigest
      )
      const [shared, link] = result.skills[0].ops
      expect(shared).toEqual({
        path: home.shared,
        kind: 'keep',
        status: 'failed',
        error: 'EXDEV',
        ...(kept === 'stable' && { currentConfirmed: true }),
        backupRefusal: { path: late.oldPath(), source: 'moved-aside' }
      })
      if (kept === 'stable') {
        expect(link.status).toBe('done')
        expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
      } else {
        // No agent link may point at a copy that changed after its check.
        expect(link.status).toBe('skipped')
        expect(await snapshot(home.claude)).toBe('missing')
      }
    }
  )
})

function refusingFilesystem(
  backups: string,
  refuse: (source: string) => boolean,
  beforeRefusal: () => Promise<void> = async () => undefined
): BundledSkillFilesystem {
  return {
    ...nativeBundledSkillFilesystem,
    rename: async (source, target) => {
      if (dirname(target) === backups && refuse(source)) {
        await beforeRefusal()
        throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
      }
      return nativeBundledSkillFilesystem.rename(source, target)
    }
  }
}

describe('refusal outcomes', () => {
  it('reports a backup that finished before a later refusal', async () => {
    const home = await makeSkillHome()
    const leftover = join(dirname(home.shared), `.${NAME}.orca-old-earlier`)
    await writeCopy(home.shared, `${OLD_TEXT}Local edit\n`)
    await writeCopy(leftover, `${OLD_TEXT}Earlier edit\n`)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const input = serviceInput(home, { agents: [], force: [home.shared] })
    const plan = await previewBundledSkillInstall(input)
    expect(plan.skills[0].ops[0].cleanup).toMatchObject([{ path: leftover, action: 'backup' }])
    const filesystem = refusingFilesystem(backups, (source) => source === home.shared)
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    const [backup] = await readdir(backups)
    expect(result.skills[0].ops[0]).toEqual({
      path: home.shared,
      kind: 'replace',
      status: 'failed',
      error: 'EXDEV',
      backupPath: join(backups, backup),
      backupPaths: [join(backups, backup)],
      backupRefusal: { path: home.shared, source: 'in-place' }
    })
    expect(await readFile(join(backups, backup, 'SKILL.md'), 'utf8')).toBe(
      `${OLD_TEXT}Earlier edit\n`
    )
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Local edit\n`)
  })

  it('does not call an EXDEV outside the backup move a refusal', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        if (source.includes('.orca-stage-') && target === home.shared) {
          throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
        }
        return nativeBundledSkillFilesystem.rename(source, target)
      }
    }
    const input = serviceInput(home, { agents: [] })
    const plan = await previewBundledSkillInstall(input)
    expect(plan.skills[0].ops[0].kind).toBe('update')
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    expect(result.skills[0].ops[0]).toEqual({
      path: home.shared,
      kind: 'update',
      status: 'failed',
      error: 'EXDEV'
    })
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(OLD_TEXT)
  })

  it.each(['stable', 'changed'] as const)(
    'links to a %s current copy only if it is rechecked after its cleanup is refused',
    async (parent) => {
      const home = await makeSkillHome()
      const leftover = join(dirname(home.shared), `.${NAME}.orca-old-earlier`)
      await writeCopy(home.shared, NEW_TEXT)
      await writeCopy(leftover, `${OLD_TEXT}Earlier edit\n`)
      const backups = join(home.home, '.agents', '.orca-skill-backups')
      const digests = join(home.home, '.agents', '.orca-skill-digests')
      const input = serviceInput(home, { agents: ['claude'] })
      const plan = await previewBundledSkillInstall(input)
      expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([
        [home.shared, 'keep'],
        [home.claude, 'link']
      ])
      const filesystem = refusingFilesystem(
        backups,
        (source) => source === leftover,
        async () => {
          if (parent === 'changed') {
            await writeFile(join(home.shared, 'SKILL.md'), 'changed after planning\n')
          }
        }
      )
      const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
      const [shared, link] = result.skills[0].ops
      expect(shared).toMatchObject({
        path: home.shared,
        kind: 'keep',
        status: 'failed',
        error: 'EXDEV',
        backupRefusal: { path: leftover, source: 'leftover' }
      })
      expect(await readFile(join(leftover, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Earlier edit\n`)
      if (parent === 'stable') {
        expect(shared.currentConfirmed).toBe(true)
        expect(shared.contentApplied).toBeUndefined()
        expect(link.status).toBe('done')
        expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
        expect(await readdir(join(digests, NAME))).toEqual([plan.skills[0].digest])
      } else {
        expect(shared.currentConfirmed).toBeUndefined()
        expect(link.status).toBe('skipped')
        expect(await snapshot(home.claude)).toBe('missing')
        expect(await snapshot(digests)).toBe('missing')
      }
    }
  )
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
})

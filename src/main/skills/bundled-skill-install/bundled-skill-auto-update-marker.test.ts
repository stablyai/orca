import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from './bundled-skill-filesystem'
import {
  autoUpdateInstalledBundledSkills,
  previewBundledSkillInstall
} from './bundled-skill-installation'
import { recordBundledSkillDigestWritten } from './bundled-skill-written-digests'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy,
  type SkillHome
} from './testing/bundled-skill-home'

afterEach(removeSkillHomes)

const ALIAS = 'former-skill'

/** A current shared copy and a released copy under a former name, so the update retires it. */
async function currentSharedWithFormerName(home: SkillHome) {
  await writeCopy(home.shared, NEW_TEXT)
  await writeCopy(join(dirname(home.claude), ALIAS), OLD_TEXT)
  return {
    ...serviceInput(home, { agents: ['claude'], installedOnly: true }),
    sources: [{ ...NEW_SOURCE, aliases: [ALIAS] }]
  }
}

/** Changes the shared copy right before the run rechecks it (the plan's own read is the first). */
function changingSharedFilesystem(home: SkillHome): BundledSkillFilesystem {
  const shared = join(home.shared, 'SKILL.md')
  let reads = 0
  return {
    ...nativeBundledSkillFilesystem,
    readFile: async (path, maxBytes) => {
      if (path === shared && ++reads === 2) {
        await writeFile(shared, 'changed after planning\n')
      }
      return nativeBundledSkillFilesystem.readFile(path, maxBytes)
    }
  }
}

describe('automatic update digest marker', () => {
  it('records no marker from the locked plan once the run found the current copy changed', async () => {
    const home = await makeSkillHome()
    const input = await currentSharedWithFormerName(home)
    const plan = await previewBundledSkillInstall(input)
    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'link'])
    const result = await autoUpdateInstalledBundledSkills({
      ...input,
      filesystem: changingSharedFilesystem(home),
      names: [NAME]
    })
    expect(result.skills[0].ops.map((op) => [op.kind, op.status])).toEqual([
      ['keep', 'changed'],
      ['link', 'skipped']
    ])
    expect(await snapshot(join(home.home, '.agents', '.orca-skill-digests'))).toBe('missing')
  })

  it('still records a marker for a current copy on a record-only call', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    const input = serviceInput(home, { agents: [], installedOnly: true })
    const plan = await previewBundledSkillInstall(input)
    await autoUpdateInstalledBundledSkills({ ...input, names: [NAME], recordOnly: true })
    expect(await snapshot(join(home.home, '.agents', '.orca-skill-digests', NAME))).not.toBe(
      'missing'
    )
    expect(plan.skills[0].ops[0].kind).toBe('keep')
  })

  it.each(['changed', 'unchanged'] as const)(
    'counts a former name as current only if its retirement did not find it %s',
    async (alias) => {
      const home = await makeSkillHome()
      const former = join(dirname(home.claude), ALIAS)
      const other = '---\nname: test-skill\ndescription: Other build\n---\n\nOther\n'
      // Another build's shared copy (no write evidence of ours), a current former-name copy with a
      // stage left over (a recovery keep), and the canonical link that retires the former name.
      await writeCopy(home.shared, other)
      await writeCopy(former, NEW_TEXT)
      await mkdir(join(dirname(home.claude), `.${ALIAS}.orca-stage-abc`), { recursive: true })
      const input = {
        ...serviceInput(home, { agents: ['claude'], installedOnly: true }),
        sources: [{ ...NEW_SOURCE, aliases: [ALIAS] }]
      }
      const first = await previewBundledSkillInstall(input)
      const shared = first.skills[0].ops.find((op) => op.path === home.shared)
      await recordBundledSkillDigestWritten(
        nativeBundledSkillFilesystem,
        home.home,
        NAME,
        shared?.observed.kind === 'folder' ? (shared.observed.skillDigest ?? '') : ''
      )
      const digests = join(home.home, '.agents', '.orca-skill-digests', NAME)
      const before = await snapshot(digests)
      const plan = await previewBundledSkillInstall(input)
      expect(plan.skills[0].ops.map((op) => [op.path, op.kind, op.reason])).toEqual([
        [home.shared, 'leave', 'other-build'],
        [home.claude, 'link', undefined],
        [former, 'keep', undefined]
      ])
      const filesystem: BundledSkillFilesystem = {
        ...nativeBundledSkillFilesystem,
        createLink: async (target, path) => {
          await nativeBundledSkillFilesystem.createLink(target, path)
          if (alias === 'changed' && path === home.claude) {
            await writeFile(join(former, 'SKILL.md'), 'edited before its retirement\n')
          }
        }
      }
      const result = await autoUpdateInstalledBundledSkills({ ...input, filesystem, names: [NAME] })
      const link = result.skills[0].ops.find((op) => op.path === home.claude)
      if (alias === 'changed') {
        expect(link?.status).not.toBe('done')
        expect(await snapshot(digests)).toBe(before)
      } else {
        expect(link?.status).toBe('done')
        expect(await snapshot(digests)).not.toBe(before)
      }
    }
  )

  // Another build's shared copy (no write evidence of ours), a current former-name copy with a stage
  // left over (a recovery keep), and a canonical link (existing or new) that retires the former name.
  async function formerNameTopology(home: SkillHome, canonical: 'existing link' | 'new link') {
    const former = join(dirname(home.claude), ALIAS)
    await writeCopy(home.shared, '---\nname: test-skill\ndescription: Other build\n---\n\nOther\n')
    if (canonical === 'existing link') {
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(home.shared, home.claude)
    }
    await writeCopy(former, NEW_TEXT)
    await mkdir(join(dirname(home.claude), `.${ALIAS}.orca-stage-abc`), { recursive: true })
    const input = {
      ...serviceInput(home, { agents: ['claude'], installedOnly: true }),
      sources: [{ ...NEW_SOURCE, aliases: [ALIAS] }]
    }
    const first = await previewBundledSkillInstall(input)
    const shared = first.skills[0].ops.find((op) => op.path === home.shared)
    await recordBundledSkillDigestWritten(
      nativeBundledSkillFilesystem,
      home.home,
      NAME,
      shared?.observed.kind === 'folder' ? (shared.observed.skillDigest ?? '') : ''
    )
    const plan = await previewBundledSkillInstall(input)
    expect(
      plan.skills[0].ops.map((op) => [op.path, op.kind, op.previous?.map((p) => p.path)])
    ).toEqual([
      [home.shared, 'leave', undefined],
      [home.claude, canonical === 'existing link' ? 'keep' : 'link', [former]],
      [former, 'keep', undefined]
    ])
    return { former, input, digests: join(home.home, '.agents', '.orca-skill-digests', NAME) }
  }

  it.each(['changed', 'unchanged'] as const)(
    'counts a former name beside a confirmed existing link only if its retirement did not find it %s',
    async (alias) => {
      const home = await makeSkillHome()
      const { former, input, digests } = await formerNameTopology(home, 'existing link')
      const before = await snapshot(digests)
      let linkReads = 0
      const filesystem: BundledSkillFilesystem = {
        ...nativeBundledSkillFilesystem,
        // The plan reads the link once; the second read is the run's own recheck of it, which
        // passes. The former name changes right after, before its retirement checks it.
        readLink: async (path) => {
          const target = await nativeBundledSkillFilesystem.readLink(path)
          if (alias === 'changed' && path === home.claude && ++linkReads === 2) {
            await writeFile(join(former, 'SKILL.md'), 'edited before its retirement\n')
          }
          return target
        }
      }
      const result = await autoUpdateInstalledBundledSkills({ ...input, filesystem, names: [NAME] })
      const keep = result.skills[0].ops.find((op) => op.path === home.claude)
      if (alias === 'changed') {
        // The canonical link itself was confirmed; only the retired place was disproved.
        expect(keep).toMatchObject({ kind: 'keep', status: 'changed', currentConfirmed: true })
        expect(await readFile(join(former, 'SKILL.md'), 'utf8')).toBe(
          'edited before its retirement\n'
        )
        expect(await snapshot(digests)).toBe(before)
      } else {
        expect(keep).toMatchObject({ kind: 'keep', status: 'done' })
        expect(await snapshot(former)).toBe('missing')
        expect(await snapshot(digests)).not.toBe(before)
      }
    }
  )

  it('records no marker from a former name whose late edit was backed up during its retirement', async () => {
    const home = await makeSkillHome()
    const { former, input, digests } = await formerNameTopology(home, 'new link')
    const before = await snapshot(digests)
    let moved = ''
    let movedReads = 0
    const filesystem: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        await nativeBundledSkillFilesystem.rename(source, target)
        if (source === former) {
          moved = target
        }
      },
      // An editor saves into the moved-aside copy after its first check passed, before the second.
      readFile: async (path, maxBytes) => {
        if (moved && path === join(moved, 'SKILL.md') && ++movedReads === 2) {
          await writeFile(path, 'edited between checks\n')
        }
        return nativeBundledSkillFilesystem.readFile(path, maxBytes)
      }
    }
    const result = await autoUpdateInstalledBundledSkills({ ...input, filesystem, names: [NAME] })
    const link = result.skills[0].ops.find((op) => op.path === home.claude)
    expect(link).toMatchObject({ kind: 'link', status: 'done' })
    const [backup] = link?.backupPaths ?? []
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe('edited between checks\n')
    expect(await snapshot(former)).toBe('missing')
    expect(await snapshot(digests)).toBe(before)
  })
})

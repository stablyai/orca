import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillDeleteRequest } from '../../../shared/skill-delete-contract'
import { buildSkillDeletePlan } from './plan'
import { nativeSkillInstallFilesystem } from '../skill-install-filesystem'

/** Windows rejects `symlink` with EPERM without elevation or Developer Mode. */
const WINDOWS = process.platform === 'win32'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'orca-skill-delete-plan-'))
  roots.push(home)
  return { home }
}

async function writeSkill(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`)
  return file
}

async function request(
  skillFilePath: string,
  overrides: Partial<SkillDeleteRequest['skills'][number]> = {}
): Promise<SkillDeleteRequest> {
  const mtime = (await stat(skillFilePath).catch(() => null))?.mtimeMs ?? null
  return {
    operationId: 'op',
    skills: [
      {
        id: 'skill-id',
        directoryPath: join(skillFilePath, '..'),
        skillFilePath,
        name: 'demo',
        updatedAt: mtime,
        ...overrides
      }
    ]
  }
}

function plan(home: string, deleteRequest: SkillDeleteRequest) {
  return buildSkillDeletePlan({
    request: deleteRequest,
    target: { kind: 'native-host', cwd: undefined },
    repos: [],
    filesystem: nativeSkillInstallFilesystem,
    homeDir: home
  })
}

describe('buildSkillDeletePlan placement enumeration', () => {
  it.skipIf(WINDOWS)(
    'finds the canonical directory and every alias that resolves to it',
    async () => {
      const { home } = await fixture()
      const canonicalDirectory = join(home, '.agents', 'skills', 'demo')
      const file = await writeSkill(canonicalDirectory, 'demo')
      // An alias-dir: a symlinked directory in another agent's root.
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      await symlink(canonicalDirectory, join(home, '.claude', 'skills', 'demo'), 'dir')
      // An alias-file: a real directory whose SKILL.md is a symlink.
      const aliasFileDirectory = join(home, '.codex', 'skills', 'demo')
      await mkdir(aliasFileDirectory, { recursive: true })
      await symlink(file, join(aliasFileDirectory, 'SKILL.md'))

      const resolved = await plan(home, await request(file))
      const entry = resolved.plan.skills[0]
      expect(entry.blocked).toBeUndefined()
      expect(new Set(entry.placements.map((placement) => placement.kind))).toEqual(
        new Set(['canonical', 'alias-dir', 'alias-file'])
      )
      expect(entry.placements.map((placement) => placement.path)).toContain(canonicalDirectory)
    }
  )

  it.skipIf(WINDOWS)(
    'classifies a directory whose SKILL.md is a symlink as alias-file, not canonical',
    async () => {
      const { home } = await fixture()
      const canonicalDirectory = join(home, '.agents', 'skills', 'demo')
      const file = await writeSkill(canonicalDirectory, 'demo')
      const aliasDirectory = join(home, '.claude', 'skills', 'demo')
      await mkdir(aliasDirectory, { recursive: true })
      await symlink(file, join(aliasDirectory, 'SKILL.md'))

      const resolved = await plan(home, await request(file))
      const alias = resolved.plan.skills[0].placements.find(
        (placement) => placement.path === aliasDirectory
      )
      expect(alias?.kind).toBe('alias-file')
    }
  )

  it.skipIf(WINDOWS)(
    'removes a home-root link to content outside every root, and only the link',
    async () => {
      const { home } = await fixture()
      const outside = join(home, 'elsewhere', 'demo')
      await writeSkill(outside, 'demo')
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      await symlink(outside, join(home, '.claude', 'skills', 'demo'), 'dir')

      const resolved = await plan(
        home,
        await request(join(home, '.claude', 'skills', 'demo', 'SKILL.md'))
      )
      expect(resolved.plan.skills[0].blocked).toBeUndefined()
      expect(resolved.plan.skills[0].placements).toEqual([
        expect.objectContaining({
          path: join(home, '.claude', 'skills', 'demo'),
          kind: 'alias-dir'
        })
      ])
    }
  )

  it.skipIf(WINDOWS)(
    'deletes the links of a repo skill whose content lives outside every root',
    async () => {
      // The shape that bit a real user: `<repo>/.agents/skills/<name>` is a link
      // to a tool-managed directory elsewhere on disk. The links are Orca's to
      // remove; the content behind them is not.
      const { home } = await fixture()
      const repo = join(home, 'projects', 'app')
      const managedElsewhere = join(home, '.local', 'share', 'devex', 'skills', 'demo')
      await writeSkill(managedElsewhere, 'demo')
      await mkdir(join(repo, '.agents', 'skills'), { recursive: true })
      await symlink(managedElsewhere, join(repo, '.agents', 'skills', 'demo'), 'dir')

      const linked = join(repo, '.agents', 'skills', 'demo', 'SKILL.md')
      const resolved = await buildSkillDeletePlan({
        request: await request(linked),
        target: { kind: 'native-host', cwd: undefined },
        repos: [{ id: 'repo-1', name: 'app', path: repo } as never],
        filesystem: nativeSkillInstallFilesystem,
        homeDir: home
      })
      const entry = resolved.plan.skills[0]
      expect(entry.blocked).toBeUndefined()
      expect(entry.placements).toEqual([
        expect.objectContaining({
          path: join(repo, '.agents', 'skills', 'demo'),
          kind: 'alias-dir'
        })
      ])
      // Nothing outside the roots is ever offered for removal.
      expect(entry.placements.some((placement) => placement.path.includes('devex'))).toBe(false)
    }
  )

  it('still refuses when the content is outside and no link sits in a root', async () => {
    const { home } = await fixture()
    const outside = join(home, 'elsewhere', 'demo')
    const file = await writeSkill(outside, 'demo')
    const resolved = await plan(home, await request(file))
    expect(resolved.plan.skills[0].blocked).toBe('unowned')
    expect(resolved.plan.skills[0].placements).toEqual([])
  })

  it.skipIf(WINDOWS)(
    'refuses a bundled skill even when the row claimed a home source',
    async () => {
      const { home } = await fixture()
      const bundled = join(home, '.claude', 'skills', '.system', 'demo')
      const file = await writeSkill(bundled, 'demo')
      // Symlinked into a plain home root, which is what makes the row read `home`.
      await mkdir(join(home, '.agents', 'skills'), { recursive: true })
      await symlink(bundled, join(home, '.agents', 'skills', 'demo'), 'dir')

      const resolved = await plan(home, await request(file))
      expect(resolved.plan.skills[0].blocked).toBe('bundled')
    }
  )

  it.skipIf(WINDOWS)('refuses a plugin-cache skill symlinked into a plain home root', async () => {
    const { home } = await fixture()
    const cached = join(home, '.codex', 'plugins', 'cache', 'pack', 'demo')
    const file = await writeSkill(cached, 'demo')
    await mkdir(join(home, '.agents', 'skills'), { recursive: true })
    await symlink(cached, join(home, '.agents', 'skills', 'demo'), 'dir')

    const resolved = await plan(home, await request(file))
    expect(resolved.plan.skills[0].blocked).toBe('plugin')
  })

  it('lists an overlapping root\u2019s directory once, not twice', async () => {
    const { home } = await fixture()
    // `~/.claude/skills` is both a home root and a repo root when the home
    // directory is also the workspace; staging that path twice would fail the
    // second rename and roll the whole skill back.
    const canonicalDirectory = join(home, '.claude', 'skills', 'demo')
    const file = await writeSkill(canonicalDirectory, 'demo')
    const resolved = await buildSkillDeletePlan({
      request: await request(file),
      target: { kind: 'native-host', cwd: home },
      repos: [],
      filesystem: nativeSkillInstallFilesystem,
      homeDir: home
    })
    expect(
      resolved.plan.skills[0].placements.filter(
        (placement) => placement.path === canonicalDirectory
      )
    ).toHaveLength(1)
  })

  it('never treats a root itself as a placement', async () => {
    const { home } = await fixture()
    const root = join(home, '.agents', 'skills')
    // A SKILL.md directly in the root would otherwise look like a placement.
    const file = await writeSkill(root, 'demo')
    const resolved = await plan(home, await request(file))
    expect(resolved.plan.skills[0].placements).toEqual([])
    expect(resolved.plan.skills[0].blocked).toBe('unowned')
  })
})

describe('buildSkillDeletePlan freshness guard', () => {
  it('reports stale when the file changed beyond the tolerance', async () => {
    const { home } = await fixture()
    const file = await writeSkill(join(home, '.agents', 'skills', 'demo'), 'demo')
    const displayed = (await stat(file)).mtimeMs
    const shifted = new Date(displayed + 60_000)
    await utimes(file, shifted, shifted)

    const resolved = await plan(home, await request(file, { updatedAt: displayed }))
    expect(resolved.plan.skills[0].blocked).toBe('stale')
  })

  it('fails closed on a null updatedAt rather than skipping the check', async () => {
    const { home } = await fixture()
    const file = await writeSkill(join(home, '.agents', 'skills', 'demo'), 'demo')
    const resolved = await plan(home, await request(file, { updatedAt: null }))
    expect(resolved.plan.skills[0].blocked).toBe('stale')
  })

  it('accepts a second-granularity updatedAt, as WSL discovery reports it', async () => {
    const { home } = await fixture()
    const file = await writeSkill(join(home, '.agents', 'skills', 'demo'), 'demo')
    const seconds = Math.floor((await stat(file)).mtimeMs / 1000) * 1000
    const resolved = await plan(home, await request(file, { updatedAt: seconds }))
    expect(resolved.plan.skills[0].blocked).toBeUndefined()
  })

  it('reports missing when the skill file is gone', async () => {
    const { home } = await fixture()
    const directory = join(home, '.agents', 'skills', 'demo')
    const file = await writeSkill(directory, 'demo')
    const deleteRequest = await request(file)
    await rm(file)
    const resolved = await plan(home, deleteRequest)
    expect(resolved.plan.skills[0].blocked).toBe('missing')
  })
})

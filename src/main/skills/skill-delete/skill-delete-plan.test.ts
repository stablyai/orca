import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDeleteRequest } from '../../../shared/skill-delete-contract'
import { buildSkillDeletePlan } from './skill-delete-plan'
import './skill-delete-placement-guards'
import { nativeSkillInstallFilesystem } from '../filesystem/skill-install-filesystem'

/** Windows rejects `symlink` with EPERM without elevation or Developer Mode. */
const WINDOWS = process.platform === 'win32'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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
    'deletes the links of a repo skill whose content lives outside every root',
    async () => {
      // Remove Orca-owned links into tool-managed content while preserving external bytes.
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
      expect(entry.placements.some((placement) => placement.path.includes('devex'))).toBe(false)
    }
  )

  it.skipIf(WINDOWS)(
    'refuses a bundled skill even when the row claimed a home source',
    async () => {
      const { home } = await fixture()
      const bundled = join(home, '.claude', 'skills', '.system', 'demo')
      const file = await writeSkill(bundled, 'demo')
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

  it('never treats a root itself as a placement', async () => {
    const { home } = await fixture()
    const root = join(home, '.agents', 'skills')
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
})

describe('buildSkillDeletePlan placement matching', () => {
  it.skipIf(WINDOWS)(
    'keeps directory and file identities distinct in original placement order',
    async () => {
      const { home } = await fixture()
      const canonical = join(home, '.agents', 'skills', 'demo')
      const file = await writeSkill(canonical, 'demo')
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      await symlink(canonical, join(home, '.claude', 'skills', 'demo'), 'dir')
      const aliasFile = join(home, '.codex', 'skills', 'demo')
      await mkdir(aliasFile, { recursive: true })
      await symlink(file, join(aliasFile, 'SKILL.md'))
      await mkdir(join(home, '.grok', 'skills'), { recursive: true })
      await symlink(file, join(home, '.grok', 'skills', 'points-to-file'))
      const wrongFile = join(home, '.pi', 'agent', 'skills', 'points-to-directory')
      await mkdir(wrongFile, { recursive: true })
      await symlink(canonical, join(wrongFile, 'SKILL.md'), 'dir')

      const resolved = await buildSkillDeletePlan({
        request: await request(file),
        target: { kind: 'native-host', cwd: home },
        repos: [],
        filesystem: nativeSkillInstallFilesystem,
        homeDir: home
      })

      expect(resolved.plan.skills[0].placements.map((placement) => placement.kind)).toEqual([
        'alias-dir',
        'alias-file',
        'canonical'
      ])
      expect(resolved.plan.skills[0].placements.map((placement) => placement.path)).toEqual([
        join(home, '.claude', 'skills', 'demo'),
        aliasFile,
        canonical
      ])
      expect(
        resolved.placementRoots.get('skill-id')?.map((placement) => placement.root.sourceKind)
      ).toEqual(['home', 'home', 'home'])
    }
  )
})

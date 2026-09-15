import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({ opens: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()

  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      observed.opens += 1

      return actual.open(...args)
    }
  }
})

import * as repair from './discovery'
import { SkillScanCoalescer, SkillScanShedError } from './skill-scan-coalescer'

afterEach(() => {
  repair.clearSkillRootScanCache()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(task: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-name-repair-'))
  vi.stubEnv('HERMES_HOME', '')
  vi.stubEnv('LOCALAPPDATA', '')

  try {
    for (let index = 0; index < 48; index += 1) {
      const dir = join(root, '.agents', 'skills', `skill-${index}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\nname: skill-${index}\n---\n`)
    }

    await task(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('shares one root read across six concurrent name filters', async () => {
  await fixture(async (root) => {
    repair.clearSkillRootScanCache()
    observed.opens = 0

    const checks = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        repair.discoverSkills({
          homeDir: root,
          repos: [],
          includeCwd: false,
          names: [`skill-${index}`],
          sourceKinds: ['home']
        })
      )
    )

    expect(checks.map((result) => result.skills.map((skill) => skill.name))).toEqual(
      Array.from({ length: 6 }, (_, index) => [`skill-${index}`])
    )
    expect(observed.opens).toBe(48)
  })
})

it('reuses the raw snapshot for a new name and invalidates it on mutation', async () => {
  await fixture(async (root) => {
    const args = { homeDir: root, repos: [], includeCwd: false, sourceKinds: ['home' as const] }
    observed.opens = 0
    await repair.discoverSkills({ ...args, names: ['skill-0'] })
    const next = await repair.discoverSkills({ ...args, names: ['skill-47'] })
    expect(next.skills.map((skill) => skill.name)).toEqual(['skill-47'])
    expect(observed.opens).toBe(48)
    await writeFile(
      join(root, '.agents', 'skills', 'skill-47', 'SKILL.md'),
      '---\nname: renamed\n---\n'
    )
    repair.clearSkillRootScanCache()
    const updated = await repair.discoverSkills({ ...args, names: ['renamed'] })
    expect(updated.skills.map((skill) => skill.name)).toEqual(['renamed'])
    expect(observed.opens).toBe(96)
  })
})

it('retains a newly requested name when its previously observed root becomes unavailable', async () => {
  await fixture(async (root) => {
    const args = { homeDir: root, repos: [], includeCwd: false, sourceKinds: ['home' as const] }
    await repair.discoverSkills({ ...args, names: ['skill-0'] })
    const original = SkillScanCoalescer.prototype.run
    vi.spyOn(SkillScanCoalescer.prototype, 'run').mockImplementation(
      function (this: SkillScanCoalescer<unknown>, key, options, task) {
        if (
          key === `home\0${join(root, '.agents', 'skills')}` ||
          key.startsWith(`home\0${join(root, '.agents', 'skills')}\0`)
        ) {
          return Promise.reject(new SkillScanShedError())
        }

        return original.call(this, key, options, task)
      }
    )
    const next = await repair.discoverSkills({ ...args, names: ['skill-47'] })
    expect(next.skills.map((skill) => skill.name)).toEqual(['skill-47'])
    expect(next.sources.find((source) => source.id === 'home-agents')?.skippedReason).toBe(
      'unavailable'
    )
  })
})

it('keeps simultaneous forced refreshes independent', async () => {
  await fixture(async (root) => {
    const args = { homeDir: root, repos: [], includeCwd: false, sourceKinds: ['home' as const] }
    await repair.discoverSkills({ ...args, names: ['skill-0'] })
    observed.opens = 0

    const results = await Promise.all(
      [0, 1].map((index) =>
        repair.discoverSkills({ ...args, names: [`skill-${index}`], refresh: true })
      )
    )

    expect(results.map((result) => result.skills[0]?.name)).toEqual(['skill-0', 'skill-1'])
    expect(observed.opens).toBe(96)
  })
})

it('filters aliases before deduplication so excluded bundled roots cannot own home results', async () => {
  await fixture(async (root) => {
    const bundled = join(root, '.codex', 'skills', '.system', 'bundle')
    const alias = join(root, '.agents', 'skills', 'bundle-alias')
    await mkdir(bundled, { recursive: true })
    await writeFile(join(bundled, 'SKILL.md'), '---\nname: bundle\n---\n')
    await symlink(bundled, alias, 'dir')

    const result = await repair.discoverSkills({
      homeDir: root,
      repos: [],
      includeCwd: false,
      names: ['bundle'],
      sourceKinds: ['home']
    })

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      sourceKind: 'home',
      rootPath: join(root, '.agents', 'skills')
    })
  })
})

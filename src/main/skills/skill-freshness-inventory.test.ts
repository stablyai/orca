import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/types'
import type {
  SkillBundleFileIdentity,
  SkillCurrentBundleEntry,
  SkillKnownSnapshot
} from '../../shared/skill-freshness'
import {
  inventorySkillFreshness,
  MAXIMUM_REPOSITORY_SKILL_ROOTS
} from './skill-freshness-inventory'
import { describeObservedSkillFile, skillPackageDigest } from './skill-package-identity'

const temporaryDirectories: string[] = []

function snapshot(releaseRevision: number, markdown: string): SkillKnownSnapshot {
  const observed = describeObservedSkillFile('SKILL.md', Buffer.from(markdown), false)
  const file: SkillBundleFileIdentity = {
    path: observed.path,
    size: observed.size,
    executable: observed.executable,
    classification: observed.classification,
    exactSha256: observed.exactSha256,
    textNormalizedSha256: observed.textNormalizedSha256,
    identitySha256: observed.identitySha256
  }
  return {
    releaseRevision,
    packageDigest: skillPackageDigest([file]),
    gitTreeSha: releaseRevision.toString(16).padStart(40, '0'),
    files: [file]
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-inventory-'))
  temporaryDirectories.push(root)
  const homeDir = join(root, 'home')
  const resourceRoot = join(root, 'resources')
  const skillResourceRoot = join(resourceRoot, 'skills')
  await mkdir(skillResourceRoot, { recursive: true })

  const oldMarkdown = '---\nname: orca-cli\ndescription: Old official guide.\n---\n\n# Old\n'
  const currentMarkdown =
    '---\nname: orca-cli\ndescription: Current official guide.\n---\n\n# Current\n'
  const newerMarkdown = '---\nname: orca-cli\ndescription: Newer official guide.\n---\n\n# Newer\n'
  const snapshots = [
    snapshot(1, oldMarkdown),
    snapshot(2, currentMarkdown),
    snapshot(3, newerMarkdown)
  ]
  const current: SkillCurrentBundleEntry = {
    name: 'orca-cli',
    sourcePath: 'skills/orca-cli',
    appVersion: '2.0.0',
    ...snapshots[1]
  }
  await Promise.all([
    writeFile(
      join(skillResourceRoot, 'current-manifest.json'),
      `${JSON.stringify({ schemaVersion: 1, appVersion: '2.0.0', skills: [current] }, null, 2)}\n`
    ),
    writeFile(
      join(skillResourceRoot, 'snapshot-registry.json'),
      `${JSON.stringify({ schemaVersion: 1, skills: { 'orca-cli': snapshots } }, null, 2)}\n`
    ),
    writeFile(
      join(skillResourceRoot, 'release-mapping.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          releases: [
            { appVersion: '1.0.0', skills: { 'orca-cli': 1 } },
            { appVersion: '2.0.0', skills: { 'orca-cli': 2 } },
            { appVersion: '3.0.0', skills: { 'orca-cli': 3 } }
          ]
        },
        null,
        2
      )}\n`
    )
  ])

  const writeSkill = async (rootPath: string, markdown: string): Promise<string> => {
    const directory = join(rootPath, 'orca-cli')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), markdown)
    return directory
  }
  return {
    root,
    homeDir,
    resourceRoot,
    oldMarkdown,
    currentMarkdown,
    newerMarkdown,
    writeSkill
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('read-only skill freshness inventory', () => {
  it('offers an exact older official name only when all global placements are safe', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations.map((entry) => entry.status)).toEqual(['outdated'])
    expect(inventory.installations[0]?.installedAppVersion).toBe('1.0.0')
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('labels newer known and unrecognized bytes honestly without calling them modified', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.newerMarkdown)
    await test.writeSkill(
      join(test.homeDir, '.claude', 'skills'),
      '---\nname: orca-cli\ndescription: User copy.\n---\n'
    )

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations.map((entry) => entry.status)).toEqual([
      'newer-known',
      'unrecognized'
    ])
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it('retains full-file identity without projecting unused metadata', async () => {
    const test = await fixture()
    const lateDescription = 'Description beyond the metadata parsing budget.'
    await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      `${' '.repeat(256 * 1024)}\n${lateDescription}`
    )

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations[0]).toMatchObject({
      status: 'unrecognized'
    })
    expect(inventory.installations[0]).not.toHaveProperty('description')
    expect(inventory.installations[0]?.observedPackageDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it.runIf(process.platform !== 'win32')(
    'deduplicates a provider alias to the canonical copy',
    async () => {
      const test = await fixture()
      const canonical = await test.writeSkill(
        join(test.homeDir, '.agents', 'skills'),
        test.oldMarkdown
      )
      const claudeRoot = join(test.homeDir, '.claude', 'skills')
      await mkdir(claudeRoot, { recursive: true })
      await symlink(canonical, join(claudeRoot, 'orca-cli'))

      const inventory = await inventorySkillFreshness({
        homeDir: test.homeDir,
        repos: [],
        resourceRoot: test.resourceRoot
      })

      expect(inventory.installations).toHaveLength(1)
      expect(inventory.installations[0]?.providers).toEqual(['agent-skills', 'claude'])
      expect(inventory.installations[0]?.topology).toBe('canonical-copy')
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'deduplicates aliases within an unsupported topology without hiding its poison',
    async () => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
      const shared = await test.writeSkill(join(test.root, 'shared'), test.currentMarkdown)
      const repos = await Promise.all(
        ['one', 'two'].map(async (id) => {
          const repoPath = join(test.root, `repo-${id}`)
          const root = join(repoPath, '.agents', 'skills')
          await mkdir(root, { recursive: true })
          await symlink(shared, join(root, 'orca-cli'))
          return { id, path: repoPath } as unknown as Repo
        })
      )

      const inventory = await inventorySkillFreshness({
        homeDir: test.homeDir,
        repos,
        resourceRoot: test.resourceRoot
      })

      expect(
        inventory.installations.filter((entry) => entry.topology === 'repo-scope')
      ).toHaveLength(1)
      expect(inventory.eligibleUpdateNames).toEqual([])
    }
  )

  it('keeps inaccessible placements visible and lets them poison the name', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const inaccessiblePath = join(test.homeDir, '.codex', 'skills', 'orca-cli')

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot,
      candidateLstat: async (path) => {
        if (path === inaccessiblePath) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return import('node:fs/promises').then(({ lstat }) => lstat(path))
      }
    })

    expect(inventory.installations.map((entry) => entry.status)).toEqual([
      'outdated',
      'inaccessible'
    ])
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it('does not lose an inaccessible known repository placement', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const repoPath = join(test.root, 'repo')
    const inaccessiblePath = join(repoPath, '.agents', 'skills', 'orca-cli')

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [{ id: 'repo', path: repoPath }] as unknown as Repo[],
      resourceRoot: test.resourceRoot,
      candidateLstat: async (path) => {
        if (path === inaccessiblePath) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return import('node:fs/promises').then(({ lstat }) => lstat(path))
      }
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unresolvedPath: inaccessiblePath,
          topology: 'repo-scope',
          status: 'inaccessible'
        })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it.each([
    ['repo', 'repo-scope'],
    ['plugin', 'plugin-cache']
  ] as const)(
    'keeps an official %s placement informational and name-poisoning',
    async (kind, topology) => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
      let repos: Repo[] = []
      if (kind === 'repo') {
        const repoPath = join(test.root, 'repo')
        await test.writeSkill(join(repoPath, '.agents', 'skills'), test.currentMarkdown)
        repos = [{ id: 'repo', path: repoPath }] as unknown as Repo[]
      } else {
        await test.writeSkill(
          join(test.homeDir, '.codex', 'plugins', 'cache', 'vendor', 'skills'),
          test.currentMarkdown
        )
      }

      const inventory = await inventorySkillFreshness({
        homeDir: test.homeDir,
        repos,
        resourceRoot: test.resourceRoot
      })

      expect(inventory.installations.some((entry) => entry.topology === topology)).toBe(true)
      expect(inventory.eligibleUpdateNames).toEqual([])
    }
  )

  it('accepts CRLF as the same official text identity', async () => {
    const test = await fixture()
    await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      test.oldMarkdown.replaceAll('\n', '\r\n')
    )

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })
    expect(inventory.installations[0]?.status).toBe('outdated')
  })

  it('classifies exact current bytes as current when a later snapshot reuses them', async () => {
    const test = await fixture()
    const resourceRoot = join(test.resourceRoot, 'skills')
    const registryPath = join(resourceRoot, 'snapshot-registry.json')
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    registry.skills['orca-cli'].push(snapshot(4, test.currentMarkdown))
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations[0]).toMatchObject({
      status: 'current',
      installedReleaseRevision: 2,
      installedAppVersion: '2.0.0'
    })
  })

  it('withholds updates when stored repositories exceed the probe budget', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const repos = Array.from(
      { length: MAXIMUM_REPOSITORY_SKILL_ROOTS / 2 + 1 },
      (_, index) => ({ id: `repo-${index}`, path: join(test.root, `repo-${index}`) }) as Repo
    )

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos,
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorCategory: 'repository-scan-limit', status: 'inaccessible' })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual([])
  })
})

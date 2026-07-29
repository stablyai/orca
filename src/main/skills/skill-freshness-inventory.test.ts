import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
import { getSkillFreshnessDisplayStatus } from '../../renderer/src/lib/skill-freshness-display-status'

const temporaryDirectories: string[] = []

const execFileAsync = promisify(execFile)

// Why: hashed with real git, not Orca's tree-sha port — the port validating
// itself here would prove nothing about matching the updater lock's hash.
async function gitTreeShaOf(directory: string): Promise<string> {
  const gitDir = await mkdtemp(join(tmpdir(), 'orca-skill-hash-'))
  temporaryDirectories.push(gitDir)
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: directory,
    GIT_INDEX_FILE: join(gitDir, 'scratch-index'),
    GIT_CONFIG_GLOBAL: join(gitDir, 'no-config'),
    GIT_CONFIG_SYSTEM: join(gitDir, 'no-config')
  }
  await execFileAsync('git', ['init', '--quiet'], { env, cwd: directory })
  await execFileAsync('git', ['add', '-A'], { env, cwd: directory })
  const { stdout } = await execFileAsync('git', ['write-tree'], { env, cwd: directory })
  return stdout.trim()
}

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
    ...snapshots[1]
  }
  await Promise.all([
    mkdir(join(homeDir, '.agents'), { recursive: true }).then(() =>
      writeFile(
        join(homeDir, '.agents', '.skill-lock.json'),
        `${JSON.stringify({
          version: 3,
          skills: {
            'orca-cli': {
              skillFolderHash: 'tracked-old-hash',
              skillPath: 'skills/orca-cli/SKILL.md',
              source: 'stablyai/orca'
            }
          }
        })}\n`
      )
    ),
    writeFile(
      join(skillResourceRoot, 'current-manifest.json'),
      `${JSON.stringify({ schemaVersion: 2, skills: [current] }, null, 2)}\n`
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

async function writeSkillLockHash(homeDir: string, skillFolderHash: string): Promise<void> {
  await writeFile(
    join(homeDir, '.agents', '.skill-lock.json'),
    `${JSON.stringify({
      version: 3,
      skills: {
        'orca-cli': {
          skillFolderHash,
          skillPath: 'skills/orca-cli/SKILL.md',
          source: 'stablyai/orca'
        }
      }
    })}\n`
  )
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('read-only skill freshness inventory', () => {
  it('offers an exact older official name only when all global placements are safe', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations.map((entry) => entry.status)).toEqual(['outdated'])
    expect(inventory.installations[0]?.installedAppVersion).toBe('1.0.0')
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('does not offer an older copied bundle the external updater has never registered (#10791)', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    await rm(join(test.homeDir, '.agents', '.skill-lock.json'))

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot,
      stateHome: null
    })

    expect(inventory.installations[0]).toMatchObject({
      topology: 'canonical-copy',
      status: 'outdated'
    })
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it('labels newer known and unrecognized bytes honestly without calling them modified', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.newerMarkdown)
    await test.writeSkill(
      join(test.homeDir, '.claude', 'skills'),
      '---\nname: orca-cli\ndescription: User copy.\n---\n'
    )

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
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

  it('trusts the updater lock for canonical bytes the bundle has never seen (#11220 scan half)', async () => {
    // The steady state days after a release: `skills update` installed source-repo
    // HEAD, wrote its lock, and no shipped bundle knows that revision yet.
    const test = await fixture()
    const upstreamMarkdown = `${test.newerMarkdown}\nUpstream edit no bundle has shipped.\n`
    const canonical = await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      upstreamMarkdown
    )
    await writeSkillLockHash(test.homeDir, await gitTreeShaOf(canonical))

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations[0]).toMatchObject({
      topology: 'canonical-copy',
      status: 'newer-known'
    })
    // Why: ahead of the bundle means there is nothing this build can update to.
    expect(inventory.eligibleUpdateNames).toEqual([])
    // The user-visible verdict, across both halves of the fix: the row must read
    // up to date, not amber "may be modified… remove it" over the CLI's own install.
    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('up-to-date')
  })

  it('still flags canonical bytes that do not match what the lock says was installed', async () => {
    const test = await fixture()
    const editedMarkdown = `${test.currentMarkdown}\nLocal edit the updater never wrote.\n`
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), editedMarkdown)
    const elsewhere = await test.writeSkill(join(test.root, 'elsewhere'), test.newerMarkdown)
    await writeSkillLockHash(test.homeDir, await gitTreeShaOf(elsewhere))

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations[0]).toMatchObject({
      topology: 'canonical-copy',
      status: 'unrecognized'
    })
    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('needs-attention')
  })

  it('does not let the lock vouch for a same-name copy outside the placements it wrote', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const independent = await test.writeSkill(
      join(test.homeDir, '.claude', 'skills'),
      '---\nname: orca-cli\n---\n\nAnother tool.\n'
    )
    await writeSkillLockHash(test.homeDir, await gitTreeShaOf(independent))

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'independent-copy', status: 'unrecognized' })
      ])
    )
    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('needs-attention')
  })

  it('retains full-file identity without projecting unused metadata', async () => {
    const test = await fixture()
    const lateDescription = 'Description beyond the metadata parsing budget.'
    await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      `${' '.repeat(256 * 1024)}\n${lateDescription}`
    )

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
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
        currentAppVersion: '2.0.0',
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
    'deduplicates aliases within an unsupported topology while still updating the canonical copy',
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
        currentAppVersion: '2.0.0',
        homeDir: test.homeDir,
        repos,
        resourceRoot: test.resourceRoot
      })

      expect(
        inventory.installations.filter((entry) => entry.topology === 'repo-scope')
      ).toHaveLength(1)
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    }
  )

  it('keeps an unreadable foreign-home placement visible without withholding the update', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const inaccessiblePath = join(test.homeDir, '.codex', 'skills', 'orca-cli')

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
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
    // Why: `--global` never writes another agent's home, so an unreadable copy there
    // cannot be harmed by the update and must not withhold it from the canonical copy.
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('does not lose an inaccessible known repository placement', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const repoPath = join(test.root, 'repo')
    const inaccessiblePath = join(repoPath, '.agents', 'skills', 'orca-cli')

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
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
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it.each([
    ['repo', 'repo-scope'],
    ['plugin', 'plugin-cache']
  ] as const)(
    'keeps an official %s placement informational without withholding the update',
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
        currentAppVersion: '2.0.0',
        homeDir: test.homeDir,
        repos,
        resourceRoot: test.resourceRoot
      })

      expect(inventory.installations.some((entry) => entry.topology === topology)).toBe(true)
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    }
  )

  it('keeps another ecosystem’s same-name plugin skill unrecognized', async () => {
    // Why: Codex ships its own `computer-use` plugin. Reported in #10633 — the copy is
    // not ours, not the user's to delete, and left amber with no action available.
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const pluginRoot = join(
      test.homeDir,
      '.codex',
      'plugins',
      'cache',
      'openai-bundled',
      'orca-cli'
    )
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'SKILL.md'), '---\nname: orca-cli\n---\n\nAnother tool.\n')

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unresolvedPath: pluginRoot,
          topology: 'plugin-cache',
          status: 'unrecognized'
        })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it('keeps a plugin-cache copy with known official files unrecognized', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const modifiedRoot = join(
      test.homeDir,
      '.codex',
      'plugins',
      'cache',
      'openai-bundled',
      'modified',
      'orca-cli'
    )
    await mkdir(modifiedRoot, { recursive: true })
    await writeFile(join(modifiedRoot, 'SKILL.md'), test.currentMarkdown)
    await writeFile(join(modifiedRoot, 'README.md'), 'Modified official package\n')

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unresolvedPath: modifiedRoot,
          status: 'unrecognized'
        })
      ])
    )
  })

  it.each([
    ['.claude', 'skills'],
    ['.agents', 'skills']
  ])('keeps an unrecognized copy under %s/%s the user’s to review', async (...segments) => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    await test.writeSkill(
      join(test.homeDir, ...segments),
      '---\nname: orca-cli\n---\n\nAnother tool.\n'
    )

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations.some((entry) => entry.status === 'unrecognized')).toBe(true)
  })

  it('does not classify an empty plugin-cache directory as a skill', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const emptyRoot = join(test.homeDir, '.codex', 'plugins', 'cache', 'vendor', 'orca-cli')
    await mkdir(emptyRoot, { recursive: true })

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations.some((entry) => entry.unresolvedPath === emptyRoot)).toBe(false)
  })

  it('accepts CRLF as the same official text identity', async () => {
    const test = await fixture()
    await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      test.oldMarkdown.replaceAll('\n', '\r\n')
    )

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
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

    // Why: the injected version deliberately differs from every mapping entry
    // to prove current placements are labeled by the running build, not history.
    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.1.0-unreleased',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations[0]).toMatchObject({
      status: 'current',
      installedReleaseRevision: 2,
      installedAppVersion: '2.1.0-unreleased',
      currentAppVersion: '2.1.0-unreleased'
    })
  })

  it('reports the repository scan limit without withholding the global update', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const repos = Array.from(
      { length: MAXIMUM_REPOSITORY_SKILL_ROOTS / 2 + 1 },
      (_, index) => ({ id: `repo-${index}`, path: join(test.root, `repo-${index}`) }) as Repo
    )

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos,
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorCategory: 'repository-scan-limit', status: 'inaccessible' })
      ])
    )
    // Why: unscanned repositories only ever hold project skills, which the global
    // command does not touch, so the limit is reported without blocking the update.
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('scans a real-shaped plugin cache completely and leaves eligibility unchanged', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const packageRoot = join(
      test.homeDir,
      '.codex',
      'plugins',
      'cache',
      'openai-bundled',
      'orca-cli',
      '1.0.0'
    )
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills/"}\n')
    const pluginSkill = await test.writeSkill(join(packageRoot, 'skills'), test.currentMarkdown)
    await mkdir(join(pluginSkill, 'templates', 'starter', 'examples', 'd1', 'app', 'api'), {
      recursive: true
    })

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    // The plugin copy is real and reported at its own path — never at a joined path,
    // and never at the same-named plugin directory two levels above it.
    expect(inventory.scanIssues).toEqual([])
    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'plugin-cache', unresolvedPath: pluginSkill })
      ])
    )
    // Why: a plugin-cache copy is not convergent, so it neither grants nor withholds
    // the update. The outdated canonical copy alone decides, exactly as before.
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('reports incomplete plugin coverage without inventing per-skill installations', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const pluginCache = join(test.homeDir, '.codex', 'plugins', 'cache')
    await mkdir(join(pluginCache, ...Array.from({ length: 11 }, (_, index) => `level-${index}`)), {
      recursive: true
    })

    const inventory = await inventorySkillFreshness({
      currentAppVersion: '2.0.0',
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot
    })

    expect(inventory.installations).toHaveLength(1)
    expect(inventory.installations[0]).toMatchObject({
      name: 'orca-cli',
      status: 'current',
      topology: 'canonical-copy'
    })
    expect(inventory.installations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorCategory: 'plugin-cache-scan-incomplete' })
      ])
    )
    expect(inventory.scanIssues).toEqual([
      expect.objectContaining({
        rootId: 'codex-plugin-cache',
        sourceLabel: 'Codex plugin cache',
        reason: 'depth-limit',
        errorCode: null
      })
    ])
  })
})

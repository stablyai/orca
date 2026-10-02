import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SkillBundleFileIdentity,
  SkillCurrentBundleEntry,
  SkillKnownSnapshot
} from '../../shared/skill-freshness'
import { describeObservedSkillFile, skillPackageDigest } from './skill-package-identity'

/**
 * The scratch HOME and bundled-artifact tree the freshness inventory reads.
 *
 * Shared rather than rebuilt per suite: the manifest, the snapshot registry and the
 * release mapping all have to agree about the same three revisions of one skill, and a
 * second hand-rolled copy of that agreement drifts into proving nothing.
 */

const temporaryDirectories: string[] = []

export function registerTemporaryDirectory(path: string): string {
  temporaryDirectories.push(path)
  return path
}

export async function removeFixtureDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
}

export function snapshot(releaseRevision: number, markdown: string): SkillKnownSnapshot {
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

export async function createSkillFreshnessFixture() {
  const root = registerTemporaryDirectory(await mkdtemp(join(tmpdir(), 'orca-skill-inventory-')))
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkillBundleManifest } from './skill-bundle-artifacts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

async function resourceRootWith(manifest: string): Promise<string> {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'orca-skill-artifacts-'))
  temporaryDirectories.push(resourceRoot)
  await mkdir(join(resourceRoot, 'skills'), { recursive: true })
  await writeFile(join(resourceRoot, 'skills', 'current-manifest.json'), manifest)
  return resourceRoot
}

describe('skill bundle manifest', () => {
  it('loads the committed schema-3 manifest and rejects a schema-2 one', async () => {
    const manifest = await readFile(resolve('resources', 'skills', 'current-manifest.json'), 'utf8')

    const loaded = await loadSkillBundleManifest(await resourceRootWith(manifest))
    expect(loaded.schemaVersion).toBe(3)
    expect(loaded.skills.length).toBeGreaterThan(0)

    // Why: schema 2 carried registry revisions; a stale artifact must fail loudly.
    const legacy = JSON.parse(manifest)
    legacy.schemaVersion = 2
    for (const skill of legacy.skills) {
      skill.releaseRevision = 1
      skill.gitTreeSha = '0'.repeat(40)
    }
    await expect(
      loadSkillBundleManifest(await resourceRootWith(JSON.stringify(legacy)))
    ).rejects.toThrow('Invalid skill bundle manifest')
  })
})

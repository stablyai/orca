import { open, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { createSkillBundleArchive } from './skill-bundle-creation'
import { installSkillBundle } from './skill-bundle-install-service'

const CHILD = process.env.ORCA_SKILL_BUNDLE_PROCESS_CHILD === '1'

async function createLargeSkill(root: string): Promise<string> {
  const source = join(root, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: crash-bundle-skill\ndescription: Process termination\n---\n\n# Bundle\n'
  )
  for (let index = 0; index < 7; index += 1) {
    await writeFile(join(source, `payload-${index}.bin`), Buffer.alloc(4 * 1024 * 1024, index))
  }
  await writeFile(join(source, 'payload-final.bin'), Buffer.alloc(3 * 1024 * 1024, 0xff))
  return source
}

async function markReady(path: string): Promise<void> {
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

describe.runIf(CHILD)('skill bundle process termination child', () => {
  it('extracts a bundle until the parent terminates this process', async () => {
    const root = process.env.ORCA_SKILL_BUNDLE_CRASH_ROOT
    const marker = process.env.ORCA_SKILL_BUNDLE_CRASH_MARKER
    if (!root || !marker) {
      throw new Error('missing-bundle-crash-environment')
    }
    const source = await createLargeSkill(root)
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: source }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_bundle_crash',
      versionId: 'version_bundle_crash',
      bundleName: 'crash-bundle'
    })
    await markReady(marker)
    await installSkillBundle({
      operationId: 'operation_bundle_crash',
      archivePath: bundle.archivePath,
      packageId: bundle.manifest.packageId,
      versionId: bundle.manifest.versionId,
      bundleDigest: bundle.manifest.bundleDigest,
      selectedSkillIds: ['crash-bundle-skill'],
      expectedArchiveSha256: bundle.archiveSha256,
      scope: 'global',
      homeDirectory: join(root, 'home'),
      orcaStateDirectory: join(root, 'state'),
      detectedProviders: [],
      destinationIdentity: 'global:bundle-process-test',
      hostIdentity: 'bundle-process-test'
    })
  })
})

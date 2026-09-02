import { open, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import { beginSkillExtractionRecovery } from './skill-extraction-recovery'
import { installLocalSkillPackage } from './skill-install-transaction'
import { removeLocalSharedSkill } from './skill-remove-transaction'

const CHILD = process.env.ORCA_SKILL_PROCESS_CHILD === '1'

async function packageVersion(root: string, versionId: string, heading: string) {
  const source = join(root, `source-${versionId}`)
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'SKILL.md'),
    `---\nname: crash-skill\ndescription: Process termination\n---\n\n# ${heading}\n`
  )
  return createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, `${versionId}.tar.gz`),
    packageId: 'package-crash',
    versionId
  })
}

async function stopAtBoundary(phase: string, boundary: string): Promise<void> {
  if (
    phase !== process.env.ORCA_SKILL_CRASH_PHASE ||
    boundary !== process.env.ORCA_SKILL_CRASH_BOUNDARY
  ) {
    return
  }
  const marker = process.env.ORCA_SKILL_CRASH_MARKER
  if (!marker) {
    throw new Error('missing-crash-marker')
  }
  const handle = await open(marker, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await new Promise<void>(() => undefined)
}

describe.runIf(CHILD)('skill process termination child', () => {
  it('stops at the requested durable boundary', async () => {
    const root = process.env.ORCA_SKILL_CRASH_ROOT
    if (!root) {
      throw new Error('missing-crash-root')
    }
    const destinationRoot = join(root, 'skills')
    const stateDirectory = join(root, 'state')
    if (process.env.ORCA_SKILL_CRASH_OPERATION === 'extract') {
      const extraction = await beginSkillExtractionRecovery(stateDirectory, destinationRoot)
      await mkdir(extraction.extractionPath, { recursive: true })
      await writeFile(join(extraction.extractionPath, 'partial'), 'partial bytes')
      await stopAtBoundary('partial-extraction', 'after')
      return
    }
    const first = await packageVersion(root, 'version_1', 'First')
    await installLocalSkillPackage({
      operationId: 'install-first',
      archivePath: first.archivePath,
      destinationRoot,
      stateDirectory,
      scope: 'global',
      destinationIdentity: 'global:process-test',
      hostIdentity: 'process-test'
    })
    if (process.env.ORCA_SKILL_CRASH_OPERATION === 'remove') {
      await removeLocalSharedSkill(
        {
          operationId: 'remove',
          canonicalPath: join(destinationRoot, 'crash-skill'),
          stateDirectory,
          allowedProviderRoots: []
        },
        { onJournalTransition: stopAtBoundary }
      )
      return
    }
    const second = await packageVersion(root, 'version_2', 'Second')
    await installLocalSkillPackage(
      {
        operationId: 'install-second',
        archivePath: second.archivePath,
        destinationRoot,
        stateDirectory,
        scope: 'global',
        destinationIdentity: 'global:process-test',
        hostIdentity: 'process-test'
      },
      { onJournalTransition: stopAtBoundary }
    )
  })
})

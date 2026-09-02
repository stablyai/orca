import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { installLocalSkillPackage } from './skill-install-transaction'

const CHILD = process.env.ORCA_SKILL_CONTENTION_CHILD === '1'

async function waitForRelease(path: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await stat(path).catch(() => null)) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('skill-contention-release-timeout')
}

describe.runIf(CHILD)('skill process contention child', () => {
  it('runs one transaction process', async () => {
    const root = process.env.ORCA_SKILL_CONTENTION_ROOT
    const archivePath = process.env.ORCA_SKILL_CONTENTION_ARCHIVE
    const resultPath = process.env.ORCA_SKILL_CONTENTION_RESULT
    const role = process.env.ORCA_SKILL_CONTENTION_ROLE
    if (!root || !archivePath || !resultPath || !role) {
      throw new Error('missing-skill-contention-input')
    }
    const result = await installLocalSkillPackage(
      {
        operationId: `contention-${role}`,
        archivePath,
        destinationRoot: join(root, 'skills'),
        stateDirectory: join(root, 'state'),
        scope: 'global',
        destinationIdentity: 'global:contention-test',
        hostIdentity: 'contention-test',
        lockTimeoutMs: role === 'blocked' ? 1 : undefined
      },
      {
        onJournalTransition: async (phase, boundary) => {
          if (role !== 'holder' || phase !== 'prepared' || boundary !== 'before') {
            return
          }
          const readyPath = process.env.ORCA_SKILL_CONTENTION_READY
          const releasePath = process.env.ORCA_SKILL_CONTENTION_RELEASE
          if (!readyPath || !releasePath) {
            throw new Error('missing-skill-contention-coordination')
          }
          await writeFile(readyPath, `${process.pid}\n`)
          await waitForRelease(releasePath)
        }
      }
    )
    await writeFile(resultPath, JSON.stringify(result))
  })
})

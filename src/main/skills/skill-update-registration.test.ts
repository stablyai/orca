import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGloballyUpdatableSkillNames } from './skill-update-registration'

const temporaryDirectories: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-registration-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('global skill update registration', () => {
  it('reads only updateable entries from the external updater lock', async () => {
    const homeDir = await temporaryRoot()
    await mkdir(join(homeDir, '.agents'), { recursive: true })
    await writeFile(
      join(homeDir, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          orchestration: {
            skillFolderHash: 'hash',
            skillPath: 'skills/orchestration/SKILL.md',
            source: 'stablyai/orca'
          },
          copied: {},
          emptyHash: {
            skillFolderHash: '',
            skillPath: 'skills/empty-hash/SKILL.md',
            source: 'stablyai/orca'
          },
          emptyPath: {
            skillFolderHash: 'hash',
            skillPath: '',
            source: 'stablyai/orca'
          }
        }
      })
    )

    await expect(readGloballyUpdatableSkillNames({ homeDir, stateHome: null })).resolves.toEqual(
      new Set(['orchestration'])
    )
  })

  it('uses the XDG state lock when configured', async () => {
    const root = await temporaryRoot()
    const stateHome = join(root, 'state')
    await mkdir(join(stateHome, 'skills'), { recursive: true })
    await writeFile(
      join(stateHome, 'skills', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          'orca-cli': {
            skillFolderHash: 'hash',
            skillPath: 'skills/orca-cli/SKILL.md',
            source: 'stablyai/orca'
          }
        }
      })
    )

    await expect(readGloballyUpdatableSkillNames({ homeDir: root, stateHome })).resolves.toEqual(
      new Set(['orca-cli'])
    )
  })
})

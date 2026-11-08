import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  recoverSkillDeleteTransaction,
  skillDeleteJournalPath,
  writeSkillDeleteJournal,
  type SkillDeleteJournalV1
} from './skill-delete-recovery'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from '../filesystem/skill-install-filesystem'
import '../transaction-state/skill-install-provenance'
import { skillDeleteStagedName } from './skill-delete-staging-names'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ home: string; stateDirectory: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'orca-skill-delete-recovery-'))
  roots.push(home)
  const root = join(home, '.agents', 'skills')
  await mkdir(root, { recursive: true })
  return { home, stateDirectory: join(home, 'state'), root }
}

function journal(
  root: string,
  canonicalPath: string,
  overrides: Partial<SkillDeleteJournalV1> = {}
): SkillDeleteJournalV1 {
  return {
    schemaVersion: 1,
    operation: 'delete',
    phase: 'staged',
    canonicalPath,
    wslDistro: null,
    allowedRoots: [root],
    movedCount: 1,
    moves: [
      {
        sourcePath: canonicalPath,
        stagedPath: join(root, skillDeleteStagedName('demo', 'id-1')),
        kind: 'canonical'
      }
    ],
    ...overrides
  }
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

describe('recoverSkillDeleteTransaction', () => {
  it('rolls a staged phase forward by removing the staged path', async () => {
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    const entry = journal(root, canonicalPath)
    await mkdir(entry.moves[0].stagedPath, { recursive: true })
    await writeSkillDeleteJournal(stateDirectory, entry)

    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath)
    expect(await exists(entry.moves[0].stagedPath)).toBe(false)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(false)
  })

  it('rolls an interrupted staging back so the skill survives whole', async () => {
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    const entry = journal(root, canonicalPath, { phase: 'staging' })
    await mkdir(entry.moves[0].stagedPath, { recursive: true })
    await writeFile(join(entry.moves[0].stagedPath, 'SKILL.md'), 'content')
    await writeSkillDeleteJournal(stateDirectory, entry)

    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath)
    expect(await exists(canonicalPath)).toBe(true)
    expect(await exists(entry.moves[0].stagedPath)).toBe(false)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(false)
  })

  it('keeps the journal when a rollback rename fails, so startup can retry it', async () => {
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    const entry = journal(root, canonicalPath, { phase: 'staging' })
    await mkdir(entry.moves[0].stagedPath, { recursive: true })
    await writeSkillDeleteJournal(stateDirectory, entry)

    const filesystem: SkillInstallFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: () => Promise.reject(new Error('EPERM'))
    }
    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath, filesystem)

    // Retain the journal while staging remains parked so startup can retry.
    expect(await exists(entry.moves[0].stagedPath)).toBe(true)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(true)

    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath)
    expect(await exists(canonicalPath)).toBe(true)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(false)
  })

  it('clears the journal on retry after an earlier pass already restored a move', async () => {
    const { home, stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    const aliasRoot = join(home, '.claude', 'skills', 'demo')
    await mkdir(aliasRoot, { recursive: true })
    const entry = journal(root, canonicalPath, {
      phase: 'staging',
      movedCount: 2,
      allowedRoots: [root, join(home, '.claude', 'skills')],
      moves: [
        {
          sourcePath: join(aliasRoot, 'SKILL.md'),
          stagedPath: join(aliasRoot, skillDeleteStagedName('SKILL.md', 'id-2')),
          kind: 'alias-file'
        },
        {
          sourcePath: canonicalPath,
          stagedPath: join(root, skillDeleteStagedName('demo', 'id-1')),
          kind: 'canonical'
        }
      ]
    })
    // A previous pass restored canonical content; only the alias-file remains staged.
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(entry.moves[0].stagedPath, 'link-stand-in')
    await writeSkillDeleteJournal(stateDirectory, entry)

    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath)
    expect(await exists(join(aliasRoot, 'SKILL.md'))).toBe(true)
    expect(await exists(canonicalPath)).toBe(true)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(false)
  })
})

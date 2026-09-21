import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readSkillDeleteRecoveryJournal,
  recoverSkillDeleteTransaction,
  skillDeleteJournalPath,
  writeSkillDeleteJournal,
  type SkillDeleteJournalV1
} from './recovery'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from '../skill-install-filesystem'
import { writeSkillStateFile } from '../skill-install-provenance'
import { skillDeleteStagedName } from './staging-names'

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

describe('skill delete journal validation', () => {
  it('round-trips a valid journal', async () => {
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    await writeSkillDeleteJournal(stateDirectory, journal(root, canonicalPath))
    expect(await readSkillDeleteRecoveryJournal(stateDirectory, canonicalPath)).toMatchObject({
      operation: 'delete',
      phase: 'staged'
    })
  })

  it('returns null when there is no journal', async () => {
    const { stateDirectory, root } = await fixture()
    expect(await readSkillDeleteRecoveryJournal(stateDirectory, join(root, 'demo'))).toBeNull()
  })

  it('refuses a move whose source escapes every allowed root', async () => {
    const { home, stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    const escaped = join(home, 'elsewhere', 'demo')
    await writeSkillStateFile(
      skillDeleteJournalPath(stateDirectory, canonicalPath),
      journal(root, canonicalPath, {
        moves: [
          {
            sourcePath: escaped,
            stagedPath: join(home, 'elsewhere', skillDeleteStagedName('demo', 'id-1')),
            kind: 'canonical'
          }
        ]
      })
    )
    await expect(readSkillDeleteRecoveryJournal(stateDirectory, canonicalPath)).rejects.toThrow(
      'skill-delete-journal-invalid'
    )
  })

  it('refuses a staged path that is not our sibling naming convention', async () => {
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    await writeSkillStateFile(
      skillDeleteJournalPath(stateDirectory, canonicalPath),
      journal(root, canonicalPath, {
        moves: [
          { sourcePath: canonicalPath, stagedPath: join(root, 'demo.bak'), kind: 'canonical' }
        ]
      })
    )
    await expect(readSkillDeleteRecoveryJournal(stateDirectory, canonicalPath)).rejects.toThrow(
      'skill-delete-journal-invalid'
    )
  })

  it('refuses a movedCount larger than the move list', async () => {
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    await writeSkillStateFile(
      skillDeleteJournalPath(stateDirectory, canonicalPath),
      journal(root, canonicalPath, { movedCount: 4 })
    )
    await expect(readSkillDeleteRecoveryJournal(stateDirectory, canonicalPath)).rejects.toThrow(
      'skill-delete-journal-invalid'
    )
  })
})

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

    // Journal retained: the staged path is still parked, and dropping the record
    // would strand it with nothing left to retry from.
    expect(await exists(entry.moves[0].stagedPath)).toBe(true)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(true)

    // Retry on a working filesystem completes and only then clears the journal.
    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath)
    expect(await exists(canonicalPath)).toBe(true)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(false)
  })

  it('clears the journal when the recorded move was never performed', async () => {
    // The journal records intent before each rename, so a crash in that window
    // leaves a move whose staged path never existed. Rollback must read that as
    // already restored, not fail it and retry the same journal at every startup.
    const { stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    await mkdir(canonicalPath, { recursive: true })
    await writeSkillDeleteJournal(
      stateDirectory,
      journal(root, canonicalPath, { phase: 'staging' })
    )

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
    // The canonical move came back in an interrupted earlier pass; only the
    // alias-file is still parked at its staged path.
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(entry.moves[0].stagedPath, 'link-stand-in')
    await writeSkillDeleteJournal(stateDirectory, entry)

    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath)
    expect(await exists(join(aliasRoot, 'SKILL.md'))).toBe(true)
    expect(await exists(canonicalPath)).toBe(true)
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalPath))).toBe(false)
  })

  it('restores canonical before alias-file, so no alias dangles mid-recovery', async () => {
    const { home, stateDirectory, root } = await fixture()
    const canonicalPath = join(root, 'demo')
    const aliasRoot = join(home, '.claude', 'skills', 'demo')
    await mkdir(aliasRoot, { recursive: true })
    const entry = journal(root, canonicalPath, {
      phase: 'staging',
      movedCount: 2,
      allowedRoots: [root, join(home, '.claude', 'skills')],
      // Staging order is alias-file first, then canonical, so plain reversal
      // gives canonical-first restore.
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
    await mkdir(entry.moves[1].stagedPath, { recursive: true })
    await writeFile(entry.moves[0].stagedPath, 'link-stand-in')
    await writeSkillDeleteJournal(stateDirectory, entry)

    const order: string[] = []
    await recoverSkillDeleteTransaction(stateDirectory, canonicalPath, {
      prepareExtractedSkill: async () => undefined,
      observeSkill: async () => {
        throw new Error('unused')
      },
      rename: async (_source, target) => {
        order.push(target)
      },
      remove: async () => undefined
    })
    expect(order).toEqual([canonicalPath, join(aliasRoot, 'SKILL.md')])
  })
})

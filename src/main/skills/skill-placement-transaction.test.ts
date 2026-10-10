import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import { readSkillInstallReceipt } from './skill-install-provenance'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { createSkillPlacementTransaction } from './skill-placement-transaction-controller'
import {
  readSkillPlacementRecoveryJournal,
  skillPlacementJournalPath
} from './skill-placement-recovery-journal'
import { recoverSkillPlacementTransaction } from './skill-placement-transaction'

const roots: string[] = []

async function skill(root: string, body: string): Promise<{ path: string; digest: string }> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'SKILL.md'), body)
  return {
    path: root,
    digest: (await nativeSkillInstallFilesystem.observeSkill(root)).observedDigest
  }
}

function receipt(
  canonicalPath: string,
  packageDigest: string,
  versionId: string,
  placements: SkillInstallReceiptV1['placements']
): SkillInstallReceiptV1 {
  return {
    schemaVersion: 1,
    packageId: 'package_1',
    versionId,
    packageDigest,
    archiveSha256: 'a'.repeat(64),
    scope: 'global',
    destinationIdentity: 'global:test',
    canonicalPath,
    placements,
    installedAt: new Date().toISOString(),
    hostIdentity: 'test',
    fileModes: []
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill placement transaction recovery', () => {
  it('does not persist empty global root overrides for a workspace transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-workspace-root-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const canonical = await skill(join(workspace, '.agents', 'skills', 'alpha'), '# Skill')
    const stateDirectory = join(root, 'state')
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'workspace',
      homeDirectory: join(root, 'home'),
      workspaceDirectory: workspace,
      detectedProviders: ['claude'],
      providerRootOverrides: {}
    })
    await transaction.prepare(null, receipt(canonical.path, canonical.digest, 'version_1', []))

    const journal = await readSkillPlacementRecoveryJournal(stateDirectory, canonical.path)
    expect(journal).not.toBeNull()
    expect(journal).not.toHaveProperty('providerRootOverrides')
  })

  it('rebuilds a partial staged copy and publishes its placement receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-partial-'))
    roots.push(root)
    const canonical = await skill(join(root, 'home', '.agents', 'skills', 'alpha'), '# New')
    const stateDirectory = join(root, 'state')
    const next = receipt(canonical.path, canonical.digest, 'version_1', [])
    const filesystem = {
      ...nativeSkillInstallFilesystem,
      createAlias: async () => {
        throw new Error('aliases-disabled')
      }
    }
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'global',
      homeDirectory: join(root, 'home'),
      detectedProviders: ['claude'],
      filesystem
    })
    await transaction.prepare(null, next)
    const journal = await readSkillPlacementRecoveryJournal(stateDirectory, canonical.path)
    if (!journal?.actions[0]) {
      throw new Error('missing placement action')
    }
    await mkdir(journal.actions[0].stagingPath, { recursive: true })
    await writeFile(join(journal.actions[0].stagingPath, 'partial'), 'partial')

    const recovered = await recoverSkillPlacementTransaction(
      stateDirectory,
      canonical.path,
      filesystem
    )

    expect(recovered?.placements).toEqual([
      expect.objectContaining({ provider: 'agent-skills' }),
      expect.objectContaining({ provider: 'claude', topology: 'independent-copy' })
    ])
    expect(
      await readFile(join(root, 'home', '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')
    ).toBe('# New')
    await expect(
      lstat(skillPlacementJournalPath(stateDirectory, canonical.path))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls a copy replacement forward after the old placement moved to backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-replace-'))
    roots.push(root)
    const home = join(root, 'home')
    const canonical = await skill(join(home, '.agents', 'skills', 'alpha'), '# Old')
    const providerPath = join(home, '.claude', 'skills', 'alpha')
    await cp(canonical.path, providerPath, { recursive: true })
    const previous = receipt(canonical.path, canonical.digest, 'version_1', [
      {
        provider: 'agent-skills',
        path: canonical.path,
        topology: 'canonical-copy',
        status: 'installed'
      },
      {
        provider: 'claude',
        path: providerPath,
        topology: 'independent-copy',
        status: 'installed'
      }
    ])
    await writeFile(join(canonical.path, 'SKILL.md'), '# New')
    const digest = (await nativeSkillInstallFilesystem.observeSkill(canonical.path)).observedDigest
    const next = receipt(canonical.path, digest, 'version_2', [])
    const stateDirectory = join(root, 'state')
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'global',
      homeDirectory: home,
      detectedProviders: ['claude']
    })
    await transaction.prepare(previous, next)
    const journal = await readSkillPlacementRecoveryJournal(stateDirectory, canonical.path)
    if (!journal?.actions[0]) {
      throw new Error('missing placement action')
    }
    await cp(canonical.path, journal.actions[0].stagingPath, { recursive: true })
    await rename(providerPath, journal.actions[0].backupPath)

    const recovered = await recoverSkillPlacementTransaction(stateDirectory, canonical.path)

    expect(recovered?.placements).toContainEqual(
      expect.objectContaining({ provider: 'claude', topology: 'independent-copy' })
    )
    expect(await readFile(join(providerPath, 'SKILL.md'), 'utf8')).toBe('# New')
    expect((await readSkillInstallReceipt(stateDirectory, canonical.path))?.versionId).toBe(
      'version_2'
    )
    await expect(lstat(journal.actions[0].backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the previous copy when placement and rollback renames both fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-rollback-'))
    roots.push(root)
    const home = join(root, 'home')
    const canonical = await skill(join(home, '.agents', 'skills', 'alpha'), '# Old')
    const providerPath = join(home, '.claude', 'skills', 'alpha')
    await cp(canonical.path, providerPath, { recursive: true })
    const previous = receipt(canonical.path, canonical.digest, 'version_1', [
      {
        provider: 'claude',
        path: providerPath,
        topology: 'independent-copy',
        status: 'installed'
      }
    ])
    await writeFile(join(canonical.path, 'SKILL.md'), '# New')
    const digest = (await nativeSkillInstallFilesystem.observeSkill(canonical.path)).observedDigest
    const stateDirectory = join(root, 'state')
    let failRenames = true
    const filesystem = {
      ...nativeSkillInstallFilesystem,
      createAlias: async () => {
        throw new Error('aliases-disabled')
      },
      rename: async (source: string, target: string): Promise<void> => {
        if (failRenames && source.includes('.orca-placement-staging-')) {
          throw new Error('injected-placement-rename-failure')
        }
        if (failRenames && source.includes('.orca-placement-backup-')) {
          throw new Error('injected-rollback-rename-failure')
        }
        await nativeSkillInstallFilesystem.rename(source, target)
      }
    }
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'global',
      homeDirectory: home,
      detectedProviders: ['claude'],
      filesystem
    })
    await transaction.prepare(previous, receipt(canonical.path, digest, 'version_2', []))

    const failed = await transaction.commit(receipt(canonical.path, digest, 'version_2', []))
    expect(failed.placements).toContainEqual(
      expect.objectContaining({ provider: 'claude', status: 'failed' })
    )
    failRenames = false
    await transaction.finish(failed)

    expect(await readFile(join(providerPath, 'SKILL.md'), 'utf8')).toBe('# Old')
  })

  it('moves an owned placement when Claude changes to a custom config root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-custom-root-'))
    roots.push(root)
    const home = join(root, 'home')
    const canonical = await skill(join(home, '.agents', 'skills', 'alpha'), '# Skill')
    const previousPath = join(home, '.claude', 'skills', 'alpha')
    await cp(canonical.path, previousPath, { recursive: true })
    const previous = receipt(canonical.path, canonical.digest, 'version_1', [
      {
        provider: 'claude',
        path: previousPath,
        topology: 'independent-copy',
        status: 'installed'
      }
    ])
    const next = receipt(canonical.path, canonical.digest, 'version_2', [])
    const stateDirectory = join(root, 'state')
    const customRoot = join(root, 'managed-claude', 'skills')
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'global',
      homeDirectory: home,
      detectedProviders: ['claude'],
      providerRootOverrides: { claude: customRoot }
    })
    await transaction.prepare(previous, next)

    const journal = await readSkillPlacementRecoveryJournal(stateDirectory, canonical.path)
    expect(journal?.actions).toEqual([
      expect.objectContaining({ rootPath: customRoot, desired: true }),
      expect.objectContaining({ rootPath: join(home, '.claude', 'skills'), desired: false })
    ])

    const committed = await transaction.commit(next)
    await transaction.finish(committed)

    await expect(lstat(previousPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(customRoot, 'alpha', 'SKILL.md'), 'utf8')).toBe('# Skill')
  })

  it('rejects a historical root claimed by another selected provider before journaling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-cross-provider-root-'))
    roots.push(root)
    const home = join(root, 'home')
    const canonical = await skill(join(home, '.agents', 'skills', 'alpha'), '# Skill')
    const sharedRoot = join(root, 'shared', 'skills')
    const previousPath = join(sharedRoot, 'alpha')
    await cp(canonical.path, previousPath, { recursive: true })
    const previous = receipt(canonical.path, canonical.digest, 'version_1', [
      {
        provider: 'claude',
        path: previousPath,
        topology: 'independent-copy',
        status: 'installed'
      }
    ])
    const next = receipt(canonical.path, canonical.digest, 'version_2', [])
    const stateDirectory = join(root, 'state')
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'global',
      homeDirectory: home,
      detectedProviders: ['claude', 'grok'],
      providerRootOverrides: {
        claude: join(root, 'new-claude', 'skills'),
        grok: sharedRoot
      }
    })
    await expect(transaction.prepare(previous, next)).rejects.toThrow(
      'skill-install-provider-root-ownership-conflict'
    )
    await expect(
      lstat(skillPlacementJournalPath(stateDirectory, canonical.path))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not treat a skipped historical placement as ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-placement-skipped-owner-'))
    roots.push(root)
    const home = join(root, 'home')
    const canonical = await skill(join(home, '.agents', 'skills', 'alpha'), '# Skill')
    const sharedRoot = join(root, 'shared', 'skills')
    const previous = receipt(canonical.path, canonical.digest, 'version_1', [
      {
        provider: 'claude',
        path: join(sharedRoot, 'alpha'),
        topology: 'independent-copy',
        status: 'skipped'
      }
    ])
    const next = receipt(canonical.path, canonical.digest, 'version_2', [])
    const stateDirectory = join(root, 'state')
    const transaction = createSkillPlacementTransaction({
      stateDirectory,
      scope: 'global',
      homeDirectory: home,
      detectedProviders: ['grok'],
      providerRootOverrides: { grok: sharedRoot }
    })

    await expect(transaction.prepare(previous, next)).resolves.toBeUndefined()
    await expect(
      readSkillPlacementRecoveryJournal(stateDirectory, canonical.path)
    ).resolves.not.toBeNull()
  })
})

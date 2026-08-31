import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDeleteRequest } from '../../../shared/skill-delete-contract'
import { deleteSkills } from './service'
import { acquireSkillInstallLock, skillInstallLockPath } from '../skill-install-lock'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from '../skill-install-filesystem'
import { readSkillInstallReceipt, writeSkillInstallReceipt } from '../skill-install-provenance'
import { skillDeleteJournalPath } from './recovery'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function fixture(): Promise<{
  home: string
  stateDirectory: string
  canonicalDirectory: string
  file: string
}> {
  const home = await mkdtemp(join(tmpdir(), 'orca-skill-delete-service-'))
  roots.push(home)
  const canonicalDirectory = join(home, '.agents', 'skills', 'demo')
  await mkdir(canonicalDirectory, { recursive: true })
  const file = join(canonicalDirectory, 'SKILL.md')
  await writeFile(file, '---\nname: demo\ndescription: Demo\n---\n\n# Demo\n')
  return { home, stateDirectory: join(home, 'state'), canonicalDirectory, file }
}

async function request(file: string): Promise<SkillDeleteRequest> {
  return {
    operationId: 'op',
    skills: [
      {
        id: 'skill-id',
        directoryPath: join(file, '..'),
        skillFilePath: file,
        name: 'demo',
        updatedAt: (await stat(file)).mtimeMs
      }
    ]
  }
}

function run(
  home: string,
  stateDirectory: string,
  deleteRequest: SkillDeleteRequest,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem
) {
  return deleteSkills({
    request: deleteRequest,
    target: { kind: 'native-host', cwd: undefined },
    repos: [],
    filesystem,
    stateDirectory,
    homeDir: home,
    lockTimeoutMs: 50
  })
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

describe('deleteSkills', () => {
  it('removes every placement and leaves no staged residue', async () => {
    const { home, stateDirectory, canonicalDirectory, file } = await fixture()
    const aliasDirectory = join(home, '.claude', 'skills', 'demo')
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await symlink(canonicalDirectory, aliasDirectory, 'dir')

    const result = await run(home, stateDirectory, await request(file))
    expect(result.skills[0].status).toBe('deleted')
    expect(await exists(canonicalDirectory)).toBe(false)
    expect(await exists(aliasDirectory)).toBe(false)
    expect(await readdir(join(home, '.agents', 'skills'))).toEqual([])
    expect(await exists(skillDeleteJournalPath(stateDirectory, canonicalDirectory))).toBe(false)
  })

  it('removes an alias-file symlink but keeps a directory that holds anything else', async () => {
    const { home, stateDirectory, file } = await fixture()
    const aliasDirectory = join(home, '.codex', 'skills', 'demo')
    await mkdir(aliasDirectory, { recursive: true })
    await symlink(file, join(aliasDirectory, 'SKILL.md'))
    await writeFile(join(aliasDirectory, 'notes.md'), 'kept')

    const result = await run(home, stateDirectory, await request(file))
    expect(result.skills[0].status).toBe('deleted')
    expect(await exists(join(aliasDirectory, 'SKILL.md'))).toBe(false)
    // "Not shared with another placement" is not "contains nothing else".
    expect(await exists(join(aliasDirectory, 'notes.md'))).toBe(true)
  })

  it('removes an emptied alias-file directory', async () => {
    const { home, stateDirectory, file } = await fixture()
    const aliasDirectory = join(home, '.codex', 'skills', 'demo')
    await mkdir(aliasDirectory, { recursive: true })
    await symlink(file, join(aliasDirectory, 'SKILL.md'))

    await run(home, stateDirectory, await request(file))
    expect(await exists(aliasDirectory)).toBe(false)
  })

  it('takes the lock an install of the same destination directory would take', async () => {
    const { home, stateDirectory, canonicalDirectory, file } = await fixture()
    // Keyed on the placement's literal directory path, which is what install
    // hashes — not the realpath'd file identity's dirname.
    const release = await acquireSkillInstallLock({
      path: skillInstallLockPath(stateDirectory, canonicalDirectory)
    })
    try {
      const result = await run(home, stateDirectory, await request(file))
      expect(result.skills[0].status).toBe('busy')
      expect(await exists(canonicalDirectory)).toBe(true)
    } finally {
      await release()
    }
  })

  it('continues the batch when one skill is locked by another transaction', async () => {
    const { home, stateDirectory, canonicalDirectory, file } = await fixture()
    const otherDirectory = join(home, '.agents', 'skills', 'other')
    await mkdir(otherDirectory, { recursive: true })
    const otherFile = join(otherDirectory, 'SKILL.md')
    await writeFile(otherFile, '---\nname: other\ndescription: Other\n---\n')

    const release = await acquireSkillInstallLock({
      path: skillInstallLockPath(stateDirectory, canonicalDirectory)
    })
    try {
      const [first, second] = await Promise.all([request(file), request(otherFile)])
      const result = await run(home, stateDirectory, {
        operationId: 'batch',
        skills: [first.skills[0], { ...second.skills[0], id: 'other-id', name: 'other' }]
      })
      expect(result.skills.map((skill) => skill.status)).toEqual(['busy', 'deleted'])
      expect(await exists(otherDirectory)).toBe(false)
    } finally {
      await release()
    }
  })

  it('restores every staged placement when a later rename fails', async () => {
    const { home, stateDirectory, canonicalDirectory, file } = await fixture()
    const aliasDirectory = join(home, '.claude', 'skills', 'demo')
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await symlink(canonicalDirectory, aliasDirectory, 'dir')

    let renames = 0
    const filesystem: SkillInstallFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source, target) => {
        renames += 1
        // Fail the canonical stage, which runs last.
        if (renames === 2) {
          throw new Error('EBUSY')
        }
        return nativeSkillInstallFilesystem.rename(source, target)
      }
    }

    const result = await run(home, stateDirectory, await request(file), filesystem)
    expect(result.skills[0].status).toBe('failed')
    expect(await exists(canonicalDirectory)).toBe(true)
    expect(await exists(aliasDirectory)).toBe(true)
  })

  it('reports partial with the staged paths when the rollback itself fails', async () => {
    const { home, stateDirectory, canonicalDirectory, file } = await fixture()
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await symlink(canonicalDirectory, join(home, '.claude', 'skills', 'demo'), 'dir')

    let renames = 0
    const filesystem: SkillInstallFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source, target) => {
        renames += 1
        if (renames === 1) {
          return nativeSkillInstallFilesystem.rename(source, target)
        }
        throw new Error('EACCES')
      }
    }

    const result = await run(home, stateDirectory, await request(file), filesystem)
    // Neither restored nor removed — reported as `partial`, never folded into
    // `failed`, which would wrongly imply nothing changed.
    expect(result.skills[0].status).toBe('partial')
    expect(result.skills[0].stagedPaths?.length).toBe(1)
  })

  it('reports partial rather than deleted when a staged removal fails', async () => {
    const { home, stateDirectory, file } = await fixture()
    const filesystem: SkillInstallFilesystem = {
      ...nativeSkillInstallFilesystem,
      remove: async () => {
        throw new Error('EACCES')
      }
    }
    const result = await run(home, stateDirectory, await request(file), filesystem)
    expect(result.skills[0].status).toBe('partial')
    expect(result.skills[0].stagedPaths?.length).toBe(1)
  })

  it('deletes the install receipt so no phantom managed install survives', async () => {
    const { home, stateDirectory, canonicalDirectory, file } = await fixture()
    await writeSkillInstallReceipt(stateDirectory, {
      schemaVersion: 1,
      packageId: 'package_1',
      versionId: 'version_1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      scope: 'global',
      destinationIdentity: 'identity',
      canonicalPath: canonicalDirectory,
      placements: [],
      installedAt: new Date(0).toISOString(),
      hostIdentity: 'host'
    })
    await run(home, stateDirectory, await request(file))
    expect(await readSkillInstallReceipt(stateDirectory, canonicalDirectory)).toBeNull()
  })

  it('removes a link to outside content and leaves the content itself intact', async () => {
    const { home, stateDirectory } = await fixture()
    const managedElsewhere = join(home, '.local', 'share', 'devex', 'skills', 'linked')
    await mkdir(managedElsewhere, { recursive: true })
    await writeFile(
      join(managedElsewhere, 'SKILL.md'),
      '---\nname: linked\ndescription: Linked\n---\n'
    )
    const link = join(home, '.claude', 'skills', 'linked')
    await mkdir(join(home, '.claude', 'skills'), { recursive: true })
    await symlink(managedElsewhere, link, 'dir')

    const result = await run(home, stateDirectory, await request(join(link, 'SKILL.md')))
    expect(result.skills[0].status).toBe('deleted')
    expect(await exists(link)).toBe(false)
    // The whole point: Orca removed its own pointer, not the tool's content.
    expect(await exists(join(managedElsewhere, 'SKILL.md'))).toBe(true)
  })

  it('skips a blocked skill without touching disk', async () => {
    const { home, stateDirectory, file } = await fixture()
    const deleteRequest = await request(file)
    const result = await run(home, stateDirectory, {
      ...deleteRequest,
      skills: [{ ...deleteRequest.skills[0], updatedAt: 1 }]
    })
    expect(result.skills[0]).toMatchObject({ status: 'skipped', blocked: 'stale' })
    expect(await exists(file)).toBe(true)
  })
})

import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type * as nodeFsPromises from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findRawRecursiveRemovals } from '../shared/raw-recursive-removal-scan'
import {
  WINDOWS_RM_MAX_RETRIES,
  transientLockRemovalOptions
} from '../shared/windows-transient-lock-removal'
import { nativeSkillInstallFilesystem } from './skills/skill-install-filesystem'

/** Records the options every recursive removal hands Node, while still performing the removal. */
const recorded = vi.hoisted(() => ({ rmCalls: [] as [string, unknown][] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>()
  return {
    ...actual,
    rm: (path: string, options: unknown) => {
      recorded.rmCalls.push([path, options])
      return actual.rm(path, options as Parameters<typeof actual.rm>[1])
    }
  }
})

/**
 * Deleting a workspace, a skill, a plugin, a downloaded speech model or a signed-in account is a
 * removal the user asked for and will notice. On Windows any of those trees can still be held open
 * by an indexer, antivirus or a just-exited child, so a bare
 * `rm(dir, { recursive: true, force: true })` throws EPERM and the delete silently does not happen
 * while the UI reports success. The holds are transient, which is what `maxRetries` absorbs.
 *
 * This guard is deliberately scoped to the user-facing population rather than to every recursive
 * removal in the repo: the internal staging and scratch directories are best-effort by design, and
 * the macOS-only provider paths can never benefit from a Windows retry at all.
 */
const REPO_ROOT = join(__dirname, '..', '..')

/** A deletion the user asked for, named by the region of the file that performs it. */
type UserFacingDeletion = { file: string; region: string; deletes: string }

const USER_FACING_DELETIONS: UserFacingDeletion[] = [
  {
    file: 'src/main/skills/skill-install-filesystem.ts',
    region: 'export const nativeSkillInstallFilesystem',
    deletes: 'an installed skill'
  },
  {
    file: 'src/main/plugins/plugin-install.ts',
    region: 'async function removeResolvedPluginDirectory',
    deletes: 'an installed plugin'
  },
  {
    file: 'src/main/speech/model-manager.ts',
    region: 'async deleteModel',
    deletes: 'a downloaded speech model'
  },
  {
    file: 'src/main/speech/model-manager.ts',
    region: 'async downloadModel',
    deletes: 'the model a finished download replaces'
  },
  {
    file: 'src/main/claude-accounts/claude-managed-auth-storage.ts',
    region: 'async remove',
    deletes: "a signed-in account's managed auth"
  },
  {
    file: 'src/main/browser/browser-route-partition-storage-dependencies.ts',
    region: 'export function browserRoutePartitionStorageDependencies',
    deletes: "the user's browsing data for a route partition"
  },
  {
    file: 'src/main/ipc/pet.ts',
    region: "'pet:delete'",
    deletes: 'a pet bundle the user imported'
  },
  {
    file: 'src/cli/handlers/account.ts',
    region: 'async function cleanupClaudeLoginArtifacts',
    deletes: "a removed account's config directory"
  }
]

/** The body of `region` in `source`, from its signature to the brace that closes it. */
function readRegion(source: string, region: string): string {
  const start = source.indexOf(region)
  expect(start, `region "${region}" is gone; re-point this guard at its new name`).toBeGreaterThan(
    -1
  )
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1
    } else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  throw new Error(`region "${region}" never closes`)
}

describe('user-facing deletions carry the Windows removal policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(USER_FACING_DELETIONS)(
    'removes $deletes through the retrying helper ($file)',
    ({ file, region }) => {
      const body = readRegion(readFileSync(join(REPO_ROOT, file), 'utf8'), region)
      expect(
        findRawRecursiveRemovals(body),
        `this deletes ${file} content the user asked to remove; on Windows a raw recursive rm throws EPERM on a transiently held handle. Use removeTree/removeTreeSync from src/shared/windows-transient-lock-removal.ts`
      ).toEqual([])
    }
  )

  it('the region reader returns a real body rather than an empty string', () => {
    // Without this every assertion above passes for a region that matched nothing.
    const body = readRegion(
      readFileSync(join(REPO_ROOT, 'src/main/speech/model-manager.ts'), 'utf8'),
      'async deleteModel'
    )
    expect(body).toContain('removeTree')
    expect(body.length).toBeGreaterThan(100)
  })

  it('the scan still reports a region that forgot the retries', () => {
    // Positive control: the guard above is only meaningful if this shape reddens it.
    expect(
      findRawRecursiveRemovals(
        'async remove(p) {\n  await rm(p, { recursive: true, force: true })\n}'
      )
    ).toEqual([2])
  })

  it("hands Node the retry count on Windows and leaves other platforms' calls untouched", () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(transientLockRemovalOptions()).toEqual({
      recursive: true,
      force: true,
      maxRetries: WINDOWS_RM_MAX_RETRIES,
      retryDelay: expect.any(Number)
    })
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    expect(transientLockRemovalOptions()).toEqual({ recursive: true, force: true })
  })
})

describe('the skill delete primitive', () => {
  const roots: string[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    recorded.rmCalls.length = 0
    await Promise.all(roots.splice(0).map((dir) => rm(dir, transientLockRemovalOptions())))
  })

  it('passes the retry policy to Node when deleting an installed skill on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    await nativeSkillInstallFilesystem.remove(join(tmpdir(), 'orca-absent-skill'))

    expect(recorded.rmCalls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ recursive: true, maxRetries: WINDOWS_RM_MAX_RETRIES })
    )
  })

  it('leaves the call unchanged on macOS and Linux', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })

    await nativeSkillInstallFilesystem.remove(join(tmpdir(), 'orca-absent-skill'))

    expect(recorded.rmCalls.at(-1)?.[1]).toEqual({ recursive: true, force: true })
  })

  it('still actually removes the tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-delete-'))
    roots.push(root)
    const skillDir = join(root, 'my-skill')
    mkdirSync(join(skillDir, 'nested'), { recursive: true })
    writeFileSync(join(skillDir, 'nested', 'SKILL.md'), '# skill')

    await nativeSkillInstallFilesystem.remove(skillDir)

    expect(existsSync(skillDir)).toBe(false)
  })
})

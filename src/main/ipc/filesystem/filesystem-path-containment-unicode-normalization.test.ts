import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'
import { PATH_ACCESS_DENIED_MESSAGE, resolveAuthorizedPath } from './filesystem-auth'
import { isDescendantOrEqual } from './filesystem-path-containment'

/** NFC/NFD spellings must authorize only when they reach one filesystem object; model APFS folding with a symlink on byte-exact hosts (#21172). */

const FOLDER = '테스트프로젝트'
const NFC_FOLDER = FOLDER.normalize('NFC')
const NFD_FOLDER = FOLDER.normalize('NFD')

const scratchDirs: string[] = []

async function makeScratchDir(): Promise<string> {
  // Canonicalize macOS /var temp aliases before building fixtures.
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'orca-unicode-path-'))
  scratchDirs.push(scratch)
  return scratch
}

function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/** One directory, both spellings. EEXIST means the filesystem already folded them itself. */
async function makeOneDirectoryTwoSpellings(
  scratch: string
): Promise<{ onDisk: string; registered: string }> {
  const onDisk = join(scratch, NFD_FOLDER)
  const registered = join(scratch, NFC_FOLDER)
  await mkdir(onDisk)
  try {
    await symlink(onDisk, registered, 'dir')
  } catch (error) {
    if (!isEEXIST(error)) {
      throw error
    }
  }
  return { onDisk, registered }
}

/** Two canonically equal names as two distinct directories; null where the filesystem folds them. */
async function makeDistinctSiblings(
  scratch: string
): Promise<{ registered: string; sibling: string } | null> {
  const registered = join(scratch, NFC_FOLDER)
  const sibling = join(scratch, NFD_FOLDER)
  await mkdir(registered)
  try {
    await mkdir(sibling)
  } catch (error) {
    if (isEEXIST(error)) {
      return null
    }
    throw error
  }
  return { registered, sibling }
}

function makeStore(repoPath: string): Store {
  const repo: Repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'workspace',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only these four accessors; Store is a class, so a structural double cannot satisfy it without the cast.
  return {
    getRepos: () => [repo],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('path containment across Unicode forms', () => {
  it('accepts a child of a root the filesystem spells the other way', async () => {
    const scratch = await makeScratchDir()
    const { onDisk, registered } = await makeOneDirectoryTwoSpellings(scratch)

    expect(isDescendantOrEqual(join(onDisk, 'test.txt'), registered)).toBe(true)
  })

  it('accepts the root itself under its other spelling', async () => {
    const scratch = await makeScratchDir()
    const { onDisk, registered } = await makeOneDirectoryTwoSpellings(scratch)

    expect(isDescendantOrEqual(onDisk, registered)).toBe(true)
  })

  it('denies a canonically equal sibling that is a distinct directory', async () => {
    const scratch = await makeScratchDir()
    const siblings = await makeDistinctSiblings(scratch)
    if (!siblings) {
      return
    }

    expect(
      isDescendantOrEqual(join(siblings.sibling, 'test.txt'), siblings.registered),
      'the sibling is a different directory; the user opened only the registered one'
    ).toBe(false)
  })

  it('denies a fold it cannot check against the filesystem', () => {
    // Canonically equal names without proven on-disk identity must remain denied.
    expect(
      isDescendantOrEqual(resolve(`/repos/${NFD_FOLDER}/test.txt`), resolve(`/repos/${NFC_FOLDER}`))
    ).toBe(false)
  })

  it('still rejects a sibling that only looks similar', () => {
    // 테스트 is a prefix of 테스트프로젝트, not a canonical equivalent of it.
    expect(
      isDescendantOrEqual(resolve('/repos/테스트/test.txt'), resolve(`/repos/${NFC_FOLDER}`))
    ).toBe(false)
  })

  it('still rejects an escape out of a non-ASCII root', () => {
    expect(
      isDescendantOrEqual(
        resolve(`/repos/${NFD_FOLDER}/../secrets`),
        resolve(`/repos/${NFC_FOLDER}`)
      )
    ).toBe(false)
  })

  it('leaves ASCII containment exactly as it was', () => {
    expect(isDescendantOrEqual(resolve('/repos/app/src'), resolve('/repos/app'))).toBe(true)
    expect(isDescendantOrEqual(resolve('/repos/apple'), resolve('/repos/app'))).toBe(false)
    expect(isDescendantOrEqual(resolve('/repos/app'), resolve('/repos/app'))).toBe(true)
  })
})

describe('fs:readFile authorization for a Korean-named workspace', () => {
  it('authorizes a file the filesystem spells the other way', async () => {
    const scratch = await makeScratchDir()
    const { onDisk, registered } = await makeOneDirectoryTwoSpellings(scratch)
    const file = join(onDisk, 'test.txt')
    await writeFile(file, 'hello')

    const store = makeStore(registered)
    // Await realpath first so assertion rejections stay handled.
    const expected = await realpath(file)

    await expect(
      resolveAuthorizedPath(file, store),
      'the file is inside the opened workspace; only its spelling differs'
    ).resolves.toBe(expected)
  })

  it('denies a canonically equal sibling the user never opened', async () => {
    const scratch = await makeScratchDir()
    const siblings = await makeDistinctSiblings(scratch)
    if (!siblings) {
      return
    }
    const file = join(siblings.sibling, 'test.txt')
    await writeFile(file, 'secret')

    const store = makeStore(siblings.registered)

    await expect(resolveAuthorizedPath(file, store)).rejects.toThrow(PATH_ACCESS_DENIED_MESSAGE)
  })

  it('still denies a file outside the workspace', async () => {
    const scratch = await makeScratchDir()
    await makeOneDirectoryTwoSpellings(scratch)
    const outside = join(scratch, 'outside.txt')
    await writeFile(outside, 'secret')

    const store = makeStore(join(scratch, NFC_FOLDER))

    await expect(resolveAuthorizedPath(outside, store)).rejects.toThrow(PATH_ACCESS_DENIED_MESSAGE)
  })
})

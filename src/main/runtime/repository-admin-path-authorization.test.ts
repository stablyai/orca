import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'

const lstatMock = vi.fn()
const realpathMock = vi.fn()
const readlinkMock = vi.fn()

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, lstat: lstatMock, realpath: realpathMock, readlink: readlinkMock }
})
vi.mock('../ipc/filesystem-auth', () => ({
  resolveAuthorizedPath: vi.fn(async (targetPath: string) => targetPath)
}))

const { REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE, resolveAuthorizedMutablePath } =
  await import('./repository-admin-path-authorization')

const TARGET = '/repo/notes.txt'

// Why this file exists: the guards below decide on fields of a `fs.Stats`, and 20+ suites in this
// repo hand production code a PARTIAL stat. These pin what happens when a field is absent, which no
// real-filesystem test can express — a real lstat always populates them.
describe('hard-link refusal on an uninterrogable stat', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    realpathMock.mockReset().mockImplementation(async (p: string) => p)
    readlinkMock
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('EINVAL'), { code: 'EINVAL' }))
  })

  it('refuses when nlink is missing, rather than silently allowing', async () => {
    lstatMock.mockResolvedValue({ isSymbolicLink: () => false })

    await expect(
      resolveAuthorizedMutablePath(TARGET, {} as never, { followsLink: true })
    ).rejects.toThrow(REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE)
  })

  it('refuses a genuinely hard-linked file', async () => {
    lstatMock.mockResolvedValue({ nlink: 2, isSymbolicLink: () => false })

    await expect(
      resolveAuthorizedMutablePath(TARGET, {} as never, { followsLink: true })
    ).rejects.toThrow(REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE)
  })

  it('allows an ordinary single-named file', async () => {
    lstatMock.mockResolvedValue({ nlink: 1, isSymbolicLink: () => false })

    await expect(
      resolveAuthorizedMutablePath(TARGET, {} as never, { followsLink: true })
    ).resolves.toBe(TARGET)
  })
})

// Why: the symlink exemption is what keeps "delete the link itself" working, so a stat that cannot
// answer must NOT be treated as a symlink — it takes the classifying branch instead.
describe('symlink exemption on an uninterrogable stat', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    realpathMock.mockReset()
    readlinkMock
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('EINVAL'), { code: 'EINVAL' }))
  })

  it('classifies the canonical leaf when isSymbolicLink is absent', async () => {
    lstatMock.mockResolvedValue({ nlink: 1 })
    realpathMock.mockResolvedValue('/repo/.git/config')

    await expect(
      resolveAuthorizedMutablePath('/repo/alias', {} as never, { preserveSymlink: true })
    ).rejects.toThrow(/Git repository metadata/)
  })

  it('exempts a confirmed symlink so the link itself stays removable', async () => {
    lstatMock.mockResolvedValue({ nlink: 1, isSymbolicLink: () => true })
    realpathMock.mockResolvedValue('/repo/.git/config')

    await expect(
      resolveAuthorizedMutablePath('/repo/alias', {} as never, { preserveSymlink: true })
    ).resolves.toBe('/repo/alias')
  })
})

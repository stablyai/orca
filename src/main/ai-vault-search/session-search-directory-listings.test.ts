import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'

const { readdir } = vi.hoisted(() => ({ readdir: vi.fn() }))

vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedReaddir: readdir
}))

beforeEach(() => {
  readdir.mockReset()
})

// A WSL root is a UNC path into the distro, and reading it with raw `fs` is
// what makes a stalled distro look like an empty directory. The gated primitive
// is the same one discovery walks with, so a refusal arrives as an error the
// walk treats as unverifiable rather than as "nothing here".
it('reads through the gated primitive, on the scan lane', async () => {
  const unc = '\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects'
  readdir.mockResolvedValueOnce([{ name: 'one.jsonl' }])
  const listings = new SessionSearchDirectoryListings()

  const listing = await listings.namesIn(unc)

  expect(readdir).toHaveBeenCalledWith(unc, 'scan', undefined)
  expect(listing).toEqual({ listed: true, names: new Set(['one.jsonl']) })
})

it('reports the code a failed read carried, so ENOENT and EACCES stay apart', async () => {
  readdir.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
  const listings = new SessionSearchDirectoryListings()
  expect(await listings.namesIn('/blocked')).toEqual({
    listed: false,
    code: 'EACCES',
    message: 'permission denied'
  })
})

it('reads a directory once per pass, error or not', async () => {
  readdir.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
  const listings = new SessionSearchDirectoryListings()
  await listings.namesIn('/gone')
  await listings.namesIn('/gone')
  expect(readdir).toHaveBeenCalledTimes(1)
  expect(listings.size).toBe(1)
})

it('is a real directory read when nothing is mocked out from under it', async () => {
  readdir.mockImplementation(async (path: string) => {
    const { readdir: real } = await import('node:fs/promises')
    return (await real(path, { withFileTypes: true })) as unknown
  })
  const root = join(tmpdir(), `ss-listings-${process.pid}`)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'present.jsonl'), '{}')
  const listing = await new SessionSearchDirectoryListings().namesIn(root)
  expect(listing.listed && listing.names.has('present.jsonl')).toBe(true)
})

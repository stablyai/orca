import { beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'

const { readdir } = vi.hoisted(() => ({ readdir: vi.fn() }))

vi.mock('../../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedReaddir: readdir
}))

beforeEach(() => {
  readdir.mockReset()
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

import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agyCredentialPresence } from './agy-credential-presence'

// The file store is the one agy uses here, so only the token file and the fallback marker count.
vi.mock('./native-file-credentials', () => ({ antigravityUsesFileStoreAsync: async () => true }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: vi.fn()
}))

const fsError = (code: string) => Object.assign(new Error(code), { code })

beforeEach(() => vi.mocked(stat).mockReset())
afterEach(() => vi.restoreAllMocks())

it('reads the login as absent only when its files definitively do not exist', async () => {
  vi.mocked(stat).mockRejectedValue(fsError('ENOENT'))
  expect(await agyCredentialPresence(tmpdir())).toBe('absent')
  vi.mocked(stat).mockRejectedValue(fsError('ENOTDIR'))
  expect(await agyCredentialPresence(tmpdir())).toBe('absent')
})

// A token file Orca can't stat (permissions, a busy or failing disk) may well hold the login.
it("reads an unreadable token file as can't check, never absent", async () => {
  for (const code of ['EACCES', 'EIO', 'EBUSY']) {
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith('antigravity-oauth-token')) {
        throw fsError(code)
      }
      throw fsError('ENOENT')
    })
    expect(await agyCredentialPresence(tmpdir())).toBe('locked')
  }
})

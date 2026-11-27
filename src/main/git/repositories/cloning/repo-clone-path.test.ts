import { statSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureCloneDestination } from './repo-clone-path'

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}))

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('ensureCloneDestination', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('accepts an existing directory when mkdir rejects, as Windows does for a drive root', async () => {
    vi.mocked(mkdir).mockRejectedValue(fsError('EPERM'))
    vi.mocked(stat).mockResolvedValue(statSync(tmpdir()))

    await expect(ensureCloneDestination('C:\\')).resolves.toBeUndefined()
  })

  it('rethrows the original mkdir error when the destination does not exist', async () => {
    const mkdirError = fsError('EPERM')
    vi.mocked(mkdir).mockRejectedValue(mkdirError)
    vi.mocked(stat).mockRejectedValue(fsError('ENOENT'))

    await expect(ensureCloneDestination('Q:\\missing')).rejects.toBe(mkdirError)
  })
})

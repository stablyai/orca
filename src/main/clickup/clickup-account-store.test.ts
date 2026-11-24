import { beforeEach, describe, expect, it, vi } from 'vitest'

const unlink = vi.fn<(path: string) => Promise<void>>()

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  unlink
}))

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

beforeEach(() => {
  unlink.mockReset()
})

describe('deleteToken', () => {
  it('treats a missing token file as already deleted', async () => {
    const { deleteToken } = await import('./clickup-account-store')
    unlink.mockRejectedValue(fsError('ENOENT'))
    await expect(deleteToken()).resolves.toBeUndefined()
  })

  it('surfaces a failure to remove the token so a disconnect cannot report success', async () => {
    const { deleteToken } = await import('./clickup-account-store')
    unlink.mockRejectedValue(fsError('EACCES'))
    await expect(deleteToken()).rejects.toMatchObject({ code: 'EACCES' })
  })
})

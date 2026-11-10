import { beforeEach, expect, it, vi } from 'vitest'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { invoke }, webUtils: {} }))
import { fsApi } from './fs-bridge'

beforeEach(() => {
  invoke.mockReset()
})

it('preserves the missing-file rejection for callers when IPC reports absence', async () => {
  invoke.mockResolvedValue(null)
  await expect(fsApi.stat({ filePath: '/missing.ts' })).rejects.toMatchObject({ code: 'ENOENT' })
})

it('returns existing metadata and propagates unexpected failures', async () => {
  invoke.mockResolvedValue({ size: 10, isDirectory: false, mtime: 123 })
  await expect(fsApi.stat({ filePath: '/file.ts' })).resolves.toEqual({
    size: 10,
    isDirectory: false,
    mtime: 123
  })
  invoke.mockImplementation(async () => {
    throw new Error('permission denied')
  })
  await expect(fsApi.stat({ filePath: '/file.ts' })).rejects.toThrow('permission denied')
})

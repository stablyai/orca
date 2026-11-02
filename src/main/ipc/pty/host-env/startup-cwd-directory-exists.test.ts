import { describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { wslUncDirectoryExistsAsync } from '../../../wsl'
import { probeRecoveredStartupCwdDirectory } from './startup-cwd-directory-exists'

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }))
vi.mock('../../../wsl', () => ({ wslUncDirectoryExistsAsync: vi.fn() }))

describe('recovered folder evidence', () => {
  it.each([
    ['ENOENT', false],
    ['ENOTDIR', false],
    ['EACCES', null],
    ['EIO', null]
  ] as const)('%s produces %s rather than guessing absence', async (code, verdict) => {
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error(code), { code }))
    expect(await probeRecoveredStartupCwdDirectory('/saved')).toBe(verdict)
  })

  it.each([true, false, null])(
    'uses the WSL guest verdict %s without a native probe',
    async (verdict) => {
      vi.mocked(stat).mockClear()
      vi.mocked(wslUncDirectoryExistsAsync).mockResolvedValueOnce(verdict)
      const path = String.raw`\\wsl.localhost\Ubuntu\home\saved`
      expect(await probeRecoveredStartupCwdDirectory(path)).toBe(verdict)
      expect(wslUncDirectoryExistsAsync).toHaveBeenLastCalledWith(path)
      expect(stat).not.toHaveBeenCalled()
    }
  )
})

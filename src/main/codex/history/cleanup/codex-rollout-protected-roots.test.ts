import { afterEach, expect, it, vi } from 'vitest'

const { realpath, stat } = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', () => ({ realpath, stat }))
vi.mock('../../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readWslDistroRunningState: vi.fn(async () => 'stopped')
}))

import { resolveProtectedRoots } from './codex-rollout-protected-roots'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('refuses to protect an import folder in a stopped WSL distro without touching it', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  realpath.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

  await expect(
    resolveProtectedRoots(
      {
        homes: ['C:\\Users\\me\\.codex'],
        protectedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex']
      },
      '2026/11/01/rollout'
    )
  ).rejects.toMatchObject({ code: 'WSL_DISTRO_STOPPED' })
  expect(realpath).not.toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex')
})

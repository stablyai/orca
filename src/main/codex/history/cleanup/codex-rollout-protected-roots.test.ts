import { afterEach, expect, it, vi } from 'vitest'

const { realpath, stat, probe } = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  probe: vi.fn<() => Promise<string[]>>()
}))

vi.mock('node:fs/promises', () => ({ realpath, stat }))
vi.mock('../../../wsl/discovery/distro-catalog', async () => {
  const { resolveRunningWslDistros } =
    await import('../../../wsl/discovery/wsl-running-distro-cache')
  return {
    listRunningWslDistrosAsync: (options: object) => resolveRunningWslDistros(probe, options),
    listWslDistrosAsync: async () => ['Ubuntu']
  }
})

import { resolveProtectedRoots } from './codex-rollout-protected-roots'
import { assertWslUncPathRunning } from '../../../wsl/filesystem/wsl-unc-access-gate'

const IMPORT_FOLDER = '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('refuses to protect an import folder whose distro stopped since it was last seen running, seconds ago', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  realpath.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  probe.mockResolvedValueOnce(['Ubuntu'])
  await assertWslUncPathRunning(IMPORT_FOLDER)
  // Two seconds later it has stopped, with nothing in it to tell Orca.
  probe.mockResolvedValue([])
  const later = performance.now() + 2_000
  vi.stubGlobal('performance', { now: () => later })

  await expect(
    resolveProtectedRoots(
      { homes: ['C:\\Users\\me\\.codex'], protectedRoots: [IMPORT_FOLDER] },
      '2026/11/01/rollout'
    )
  ).rejects.toMatchObject({ code: 'WSL_DISTRO_STOPPED' })
  expect(realpath).not.toHaveBeenCalledWith(IMPORT_FOLDER)
})

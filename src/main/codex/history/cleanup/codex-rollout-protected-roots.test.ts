import { afterEach, expect, it, vi } from 'vitest'

const { realpath, stat } = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', () => ({ realpath, stat }))

import { isOutsideProtectedRoots, resolveProtectedRoots } from './codex-rollout-protected-roots'

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([
  '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex',
  '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\.codex'
])('protects the WSL import folder %s without reading it', async (importFolder) => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  stat.mockResolvedValue({ dev: 1n, ino: 2n })
  // The local folder links into the distro, reaching the import folder by another path there.
  realpath.mockImplementation(async (path: string) =>
    path === 'C:/Users/me/.codex/sessions/2026/11/01'
      ? '\\\\wsl$\\ubuntu\\data\\codex\\sessions\\2026\\11\\01'
      : path
  )

  const roots = await resolveProtectedRoots(
    { homes: ['C:\\Users\\me\\.codex'], protectedRoots: [importFolder] },
    '2026/11/01/rollout'
  )
  const touched = [...realpath.mock.calls, ...stat.mock.calls].map(([path]) => path)
  expect(touched.filter((path) => /^[\\/]{2}(wsl|\?)/i.test(path))).toEqual([])

  expect(
    await isOutsideProtectedRoots('C:/Users/me/.codex/sessions/2026/11/01/rollout.jsonl', roots)
  ).toBe(false)
})

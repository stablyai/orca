import { afterEach, expect, it, vi } from 'vitest'

const { realpath, stat } = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', () => ({ realpath, stat }))

import { isOutsideProtectedRoots, resolveProtectedRoots } from './codex-rollout-protected-roots'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('protects a WSL import folder without reading it, and keeps a name that resolves into it', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  stat.mockResolvedValue({ dev: 1n, ino: 2n })
  realpath.mockImplementation(async (path: string) =>
    path === 'C:/Users/me/.codex/sessions/2026/11/01'
      ? '\\\\wsl$\\ubuntu\\home\\me\\.codex\\sessions\\2026\\11\\01'
      : path
  )

  const roots = await resolveProtectedRoots(
    {
      homes: ['C:\\Users\\me\\.codex'],
      protectedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex']
    },
    '2026/11/01/rollout'
  )
  const touched = [...realpath.mock.calls, ...stat.mock.calls].map(([path]) => path)
  expect(touched.filter((path) => path.startsWith('\\\\wsl'))).toEqual([])

  expect(
    await isOutsideProtectedRoots('C:/Users/me/.codex/sessions/2026/11/01/rollout.jsonl', roots)
  ).toBe(false)
})

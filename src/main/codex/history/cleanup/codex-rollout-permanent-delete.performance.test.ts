import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { probe } = vi.hoisted(() => ({ probe: vi.fn<() => Promise<string[]>>() }))

vi.mock('../../../wsl/discovery/distro-catalog', async () => {
  const { resolveRunningWslDistros } =
    await import('../../../wsl/discovery/wsl-running-distro-cache')
  return {
    listRunningWslDistrosAsync: (options: object) => resolveRunningWslDistros(probe, options),
    listWslDistrosAsync: async () => ['Ubuntu']
  }
})

import { _resetRunningWslDistroCacheForTests } from '../../../wsl/discovery/wsl-running-distro-cache'
import { deleteCodexRolloutsPermanently } from './codex-rollout-permanent-delete'

let root: string

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** One sweep, with each chat in its own deleted workspace folder, while the import folder's distro is stopped. */
async function sweepWhileImportDistroStopped(chats: number) {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-stopped-import-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  const home = join(root, '.codex')
  mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
  const targets = Array.from({ length: chats }, (_, index) => {
    const id = `00000001-0000-4000-8000-${String(index).padStart(12, '0')}`
    const filePath = join(
      home,
      'sessions',
      '2026',
      '11',
      '01',
      `rollout-2026-11-01T10-00-00-${id}.jsonl`
    )
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'chat\n')
    return { agent: 'codex' as const, filePath }
  })
  _resetRunningWslDistroCacheForTests()
  probe.mockReset()
  probe.mockResolvedValue([])
  // However long a sweep takes here, it stays inside one lease.
  const clock = performance.now()
  vi.stubGlobal('performance', { now: () => clock })
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const results = []
  for (const target of targets) {
    results.push(
      await deleteCodexRolloutsPermanently(
        [target],
        async () => true,
        async () => ({
          homes: [home],
          protectedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex']
        })
      )
    )
  }
  vi.unstubAllGlobals()
  return {
    deleted: results.reduce((sum, result) => sum + result.deleted + result.failed, 0),
    probes: probe.mock.calls.length,
    kept: targets.filter((target) => existsSync(target.filePath)).length
  }
}

it("asks WSL once, however many chats and folders wait on the import folder's stopped distro", async () => {
  expect(await sweepWhileImportDistroStopped(10)).toEqual({ deleted: 0, probes: 1, kept: 10 })
  expect(await sweepWhileImportDistroStopped(100)).toEqual({ deleted: 0, probes: 1, kept: 100 })
})

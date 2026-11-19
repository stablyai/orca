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

import { deleteCodexRolloutsPermanently } from './codex-rollout-permanent-delete'

let root: string

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

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
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  probe.mockReset()
  probe.mockResolvedValue([])
  const result = await deleteCodexRolloutsPermanently(
    targets,
    async () => true,
    async () => ({ homes: [home], protectedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex'] })
  )
  vi.unstubAllGlobals()
  return {
    result,
    probes: probe.mock.calls.length,
    kept: targets.filter((t) => existsSync(t.filePath)).length
  }
}

it("asks WSL once a sweep, however many chats wait on the import folder's stopped distro", async () => {
  expect(await sweepWhileImportDistroStopped(10)).toEqual({
    result: { deleted: 0, failed: 0, freedBytes: 0 },
    probes: 1,
    kept: 10
  })
  expect(await sweepWhileImportDistroStopped(100)).toEqual({
    result: { deleted: 0, failed: 0, freedBytes: 0 },
    probes: 1,
    kept: 100
  })
})

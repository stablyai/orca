import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { listHostCodexRolloutHomes } from './codex-host-rollout-homes'
import { deleteCodexRolloutsPermanently } from './codex-rollout-permanent-delete'

const DATED = ['sessions', '2026', '11', '01']
const NAME = 'rollout-2026-11-01T10-00-00-00000001-0000-4000-8000-000000000000.jsonl'

let root: string

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

function isolateHomes(): void {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-import-'))
  vi.stubEnv('HOME', join(root, 'user'))
  vi.stubEnv('USERPROFILE', join(root, 'user'))
  vi.stubEnv('CODEX_HOME', '')
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
}

it('deletes a rollout from ~/.codex but never from the Codex import folder', async () => {
  isolateHomes()
  const system = join(root, 'user', '.codex')
  const importFolder = join(root, 'import')
  const target = write(join(system, ...DATED, NAME), 'system copy\n')
  const archived = write(join(system, 'archived_sessions', NAME), 'archived copy\n')
  mkdirSync(join(system, 'thread-writer-locks'), { recursive: true })
  const imported = write(join(importFolder, ...DATED, NAME), 'import copy\n')
  const settings = { codexSessionSourceHome: { host: importFolder } }

  const result = await deleteCodexRolloutsPermanently(
    [{ agent: 'codex', filePath: target }],
    async () => true,
    () => listHostCodexRolloutHomes(settings)
  )

  expect(result.deleted).toBe(1)
  expect([target, archived].filter((path) => existsSync(path))).toEqual([])
  expect(readFileSync(imported, 'utf8')).toBe('import copy\n')
})

// Creating symlinks on Windows needs Developer Mode or admin rights.
it.skipIf(process.platform === 'win32').each([
  { place: 'beside ~/.codex', importParts: ['import'] },
  { place: 'inside ~/.codex', importParts: ['user', '.codex', 'import'] }
])(
  'deletes Orca copies but not names a ~/.codex folder links into the import folder $place',
  async ({ importParts }) => {
    isolateHomes()
    const system = join(root, 'user', '.codex')
    const importFolder = join(root, ...importParts)
    const imported = write(join(importFolder, ...DATED, NAME), 'import copy\n')
    const managed = write(
      join(root, 'user-data', 'codex-runtime-home', 'home', ...DATED, NAME),
      'managed copy\n'
    )
    mkdirSync(join(system, 'thread-writer-locks'), { recursive: true })
    symlinkSync(join(importFolder, 'sessions'), join(system, 'sessions'))
    const settings = { codexSessionSourceHome: { host: importFolder } }

    const result = await deleteCodexRolloutsPermanently(
      [{ agent: 'codex', filePath: join(system, ...DATED, NAME) }],
      async () => true,
      () => listHostCodexRolloutHomes(settings)
    )

    expect(result).toEqual({ deleted: 1, failed: 0, freedBytes: 13 })
    expect(existsSync(managed)).toBe(false)
    expect(readFileSync(imported, 'utf8')).toBe('import copy\n')
  }
)

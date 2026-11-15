import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseKimiSessionFile } from './session-scanner-kimi-parser'
import { clearKimiSessionIndexCache } from './session-scanner-kimi-paths'

let tempDirs: string[] = []

afterEach(async () => {
  clearKimiSessionIndexCache()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('parseKimiSessionFile', () => {
  it('reads Kimi Code v2 epoch-ms state timestamps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-kimi-parser-'))
    tempDirs.push(home)
    const sessionDir = join(home, 'sessions', 'wd_kimi-test', 'session_v2-epoch-ms')
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true })
    const statePath = join(sessionDir, 'state.json')
    await writeFile(
      statePath,
      JSON.stringify({ version: 2, createdAt: 1791122400000, updatedAt: 1791122400500, agents: {} })
    )
    await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), '')

    const session = await parseKimiSessionFile(
      { path: statePath, mtimeMs: 0, modifiedAt: new Date(0).toISOString() },
      'darwin'
    )

    expect(session?.createdAt).toBe('2026-10-04T14:00:00.000Z')
    expect(session?.updatedAt).toBe('2026-10-04T14:00:00.500Z')
  })
})

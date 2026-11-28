import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearKimiSessionIndexCache } from '../ai-vault/scanners/kimi/session-scanner-kimi-paths'
import { KIMI_TRANSCRIPT_IMPORT } from './kimi-transcript-import'

// Work directories and the folder names Kimi Code 2.7.2 gave them.
const SESSIONS = [
  {
    id: 'session_7bbd07e4-f28a-4b28-9f9c-59b197b4ff57',
    workDir: '/private/tmp/kimi47535/repo',
    folder: 'wd_repo_9b1d92600e40'
  },
  {
    id: 'session_f01ad39e-0c92-42b5-8596-04e7fa275938',
    workDir: '/private/tmp/kimi47535/项目',
    folder: 'wd_workspace_263184991e2e'
  }
]

let home = ''

beforeEach(async () => {
  home = join(await realpath(await mkdtemp(join(tmpdir(), 'orca-kimi-import-'))), '.kimi-code')
  for (const { id, folder } of SESSIONS) {
    const agent = join(home, 'sessions', folder, id, 'agents', 'main')
    await mkdir(agent, { recursive: true })
    await writeFile(
      join(home, 'sessions', folder, id, 'state.json'),
      '{"agents":{"main":{"type":"main"}}}'
    )
    await writeFile(join(agent, 'wire.jsonl'), '{}\n')
  }
  await writeFile(
    join(home, 'session_index.jsonl'),
    SESSIONS.map(({ id, workDir }) => JSON.stringify({ sessionId: id, workDir })).join('\n')
  )
})

afterEach(async () => {
  clearKimiSessionIndexCache()
  await rm(join(home, '..'), { recursive: true, force: true })
})

describe('KIMI_TRANSCRIPT_IMPORT', () => {
  it('finds a session in the folder Kimi names after its work directory', async () => {
    const store = join(home, 'sessions')
    const found = await Promise.all(
      [...SESSIONS.map(({ id }) => id), 'session_missing'].map((providerSessionId) =>
        KIMI_TRANSCRIPT_IMPORT.findTranscript({
          providerSessionId,
          store,
          launchEnv: {},
          workspaceCwd: '/elsewhere'
        })
      )
    )
    expect(found).toEqual([
      ...SESSIONS.map(({ id, folder }) => join(store, folder, id, 'agents', 'main', 'wire.jsonl')),
      null
    ])
  })
})

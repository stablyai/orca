import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

// Use synchronous SQLite implementations because worker bundles are absent in the test runtime.
vi.mock(
  './scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async () => {
    const v1List = await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const v1Parse = await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite')
    const v2List = await import('./scanners/opencode2/session-scanner-opencode2-sqlite-list')
    const v2Parse = await import('./scanners/opencode2/session-scanner-opencode2-sqlite')
    return {
      listOpenCodeSqliteSessionsViaWorker: (
        args: Parameters<typeof v1List.listOpenCodeSqliteSessions>[0]
      ) => v1List.listOpenCodeSqliteSessions(args),
      listZcodeSqliteSessionsViaWorker: (
        args: Parameters<typeof v1List.listOpenCodeSqliteSessions>[0]
      ) => v1List.listOpenCodeSqliteSessions({ ...args, agent: 'zcode' }),
      parseOpenCodeSqliteSessionViaWorker: (
        args: Parameters<typeof v1Parse.parseOpenCodeSqliteSession>[0]
      ) => v1Parse.parseOpenCodeSqliteSession(args),
      parseZcodeSqliteSessionViaWorker: (
        args: Parameters<typeof v1Parse.parseOpenCodeSqliteSession>[0]
      ) => v1Parse.parseOpenCodeSqliteSession({ ...args, agent: 'zcode' }),
      listOpenCode2SqliteSessionsViaWorker: (
        args: Parameters<typeof v2List.listOpenCode2SqliteSessions>[0]
      ) => v2List.listOpenCode2SqliteSessions(args),
      parseOpenCode2SqliteSessionViaWorker: (
        args: Parameters<typeof v2Parse.parseOpenCode2SqliteSession>[0]
      ) => v2Parse.parseOpenCode2SqliteSession(args)
    }
  }
)

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions', () => {
  it('indexes Codex sessions from Orca runtime homes with resumable commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-runtime-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const runtimeHome = join(root, 'codex-runtime-home', 'home')
    const runtimeSessionsDir = join(runtimeHome, 'sessions')
    await mkdir(join(runtimeSessionsDir, '2026', '06', '04'), { recursive: true })

    await writeFile(
      join(
        runtimeSessionsDir,
        '2026',
        '06',
        '04',
        'rollout-2026-06-04T23-58-22-019e9693-64fc-7370-9c18-7e625c595d0f.jsonl'
      ),
      jsonLines([
        {
          timestamp: '2026-06-04T23:58:22.000Z',
          type: 'session_meta',
          payload: {
            id: '019e9693-64fc-7370-9c18-7e625c595d0f',
            cwd: '/Users/nwparker/orca/workspaces/orca/mem4'
          }
        },
        {
          timestamp: '2026-06-04T23:58:23.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Resume this managed Codex session' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      additionalCodexSessionsDirs: [runtimeSessionsDir],
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'codex',
      sessionId: '019e9693-64fc-7370-9c18-7e625c595d0f',
      cwd: '/Users/nwparker/orca/workspaces/orca/mem4',
      codexHome: runtimeHome,
      resumeCommand: `cd '/Users/nwparker/orca/workspaces/orca/mem4' && CODEX_HOME='${runtimeHome}' codex resume '019e9693-64fc-7370-9c18-7e625c595d0f'`
    })
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// Replace the worker transport with its real in-process readers.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const list = await import('./session-scanner-opencode-sqlite-list')
  const list2 = await import('./session-scanner-opencode2-sqlite-list')
  const parse = await import('./session-scanner-opencode-sqlite')
  const parse2 = await import('./session-scanner-opencode2-sqlite')
  const capture = await import('./session-scanner-opencode-sqlite-capture')
  const capture2 = await import('./session-scanner-opencode2-sqlite')
  return {
    resolveOpenCodeSqliteWorkerEntryPath: () => null,
    listOpenCodeSqliteSessionsViaWorker: (
      args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
    ) => list.listOpenCodeSqliteSessions(args),
    listOpenCode2SqliteSessionsViaWorker: (
      args: Parameters<typeof list2.listOpenCode2SqliteSessions>[0]
    ) => list2.listOpenCode2SqliteSessions(args),
    listZcodeSqliteSessionsViaWorker: (
      args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
    ) => list.listOpenCodeSqliteSessions({ ...args, agent: 'zcode' }),
    parseOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof parse.parseOpenCodeSqliteSession>[0]
    ) => parse.parseOpenCodeSqliteSession(args),
    parseOpenCode2SqliteSessionViaWorker: (
      args: Parameters<typeof parse2.parseOpenCode2SqliteSession>[0]
    ) => parse2.parseOpenCode2SqliteSession(args),
    parseZcodeSqliteSessionViaWorker: (
      args: Parameters<typeof parse.parseOpenCodeSqliteSession>[0]
    ) => parse.parseOpenCodeSqliteSession({ ...args, agent: 'zcode' }),
    captureOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof capture.captureOpenCodeSqliteSession>[0]
    ) => capture.captureOpenCodeSqliteSession(args),
    captureOpenCode2SqliteSessionViaWorker: (
      args: Parameters<typeof capture2.captureOpenCode2SqliteSession>[0]
    ) => capture2.captureOpenCode2SqliteSession(args),
    captureZcodeSqliteSessionViaWorker: (
      args: Parameters<typeof capture.captureOpenCodeSqliteSession>[0]
    ) => capture.captureOpenCodeSqliteSession({ ...args, agent: 'zcode' })
  }
})
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'
import { writeEveryAgentVault } from './session-scanner-every-agent-fixture'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptMessage
} from './session-transcript-consumers'

const OPENCODE_SQLITE_SESSION = 'ses_capture_guard'

let tempRoots: string[] = []

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

type CapturedRead = { agent: AiVaultAgent; path: string; messages: TranscriptMessage[] }

async function readEveryAgentVault(): Promise<CapturedRead[]> {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-every-agent-'))
  tempRoots.push(root)
  const { roots } = await writeEveryAgentVault(root)
  const dbPath = join(root, 'opencode-db', 'opencode.db')
  writeOpenCodeSqliteDatabase(dbPath, [
    {
      id: OPENCODE_SQLITE_SESSION,
      turns: [
        { role: 'user', parts: ['what does the sqlite reader publish'] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'Weighing which parts carry words.' },
            'Every part of every turn.',
            {
              type: 'tool',
              tool: 'bash',
              input: { command: 'rg --count quokka' },
              output: 'src/main/ai-vault: 3'
            }
          ]
        }
      ]
    }
  ])

  const reads: CapturedRead[] = []
  registerTranscriptConsumer({
    beginRead: (start) => {
      const read: CapturedRead = {
        agent: start.candidate.agent,
        path: start.candidate.file.path,
        messages: []
      }
      reads.push(read)
      return { message: (message) => read.messages.push(message), finish: () => undefined }
    }
  })
  const result = await scanAiVaultSessions({
    ...roots,
    opencodeDbPaths: [...(roots.opencodeDbPaths ?? []), dbPath],
    platform: 'darwin',
    limit: 40
  })
  expect(result.issues).toEqual([])
  return reads
}

function spokeIn(read: CapturedRead): boolean {
  return read.messages.some((message) => message.role === 'user' || message.role === 'assistant')
}

it('publishes at least one user or assistant message for every source it reads', async () => {
  const reads = await readEveryAgentVault()

  // Check every storage source: one working OpenCode format must not mask another’s missing messages.
  expect(reads.filter((read) => !spokeIn(read)).map((read) => read.path)).toEqual([])
  expect(new Set(reads.map((read) => read.agent))).toEqual(new Set(AI_VAULT_AGENTS))
})

it('publishes an OpenCode SQLite session through the same channel as every file source', async () => {
  const reads = await readEveryAgentVault()

  const sqliteRead = reads.find(
    (read) => splitOpenCodeSqliteCandidate(read.path)?.sessionId === OPENCODE_SQLITE_SESSION
  )
  expect(sqliteRead?.messages).toEqual([
    {
      role: 'user',
      text: 'what does the sqlite reader publish',
      timestamp: expect.any(String)
    },
    {
      role: 'assistant',
      text: 'Weighing which parts carry words.\nEvery part of every turn.',
      timestamp: expect.any(String)
    },
    {
      role: 'tool',
      text: 'bash: rg --count quokka\nsrc/main/ai-vault: 3',
      timestamp: expect.any(String)
    }
  ])
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// Only the thread hop is replaced: the implementations below are the repo's own
// in-process readers, which the worker entry calls on the other side.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const list = await import('./session-scanner-opencode-sqlite-list')
  const parse = await import('./session-scanner-opencode-sqlite')
  const capture = await import('./session-scanner-opencode-sqlite-capture')
  return {
    resolveOpenCodeSqliteWorkerEntryPath: () => null,
    listOpenCodeSqliteSessionsViaWorker: (
      args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
    ) => list.listOpenCodeSqliteSessions(args),
    parseOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof parse.parseOpenCodeSqliteSession>[0]
    ) => parse.parseOpenCodeSqliteSession(args),
    captureOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof capture.captureOpenCodeSqliteSession>[0]
    ) => capture.captureOpenCodeSqliteSession(args)
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

/*
 * The guard the OpenCode capture gap needed.
 *
 * Every consumer of the transcript reader -- the search index today, a digest
 * tomorrow -- sees an agent only through the messages its parser publishes. A
 * parser can list a session, show a preview and resume it correctly while
 * publishing nothing at all, which is exactly how 606 OpenCode sessions came to
 * hold zero indexed messages. Nothing above this layer can tell the difference,
 * so the assertion has to live here: one fixture per supported agent, read the
 * way the app reads it, and every agent has to say something.
 */

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
    opencodeDbPaths: [dbPath],
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

  // Per source, not per agent: OpenCode has two storage shapes, and asking only
  // that *some* OpenCode session spoke is exactly the question that read as
  // healthy while every SQLite session in the vault was silent.
  expect(reads.filter((read) => !spokeIn(read)).map((read) => read.path)).toEqual([])
  // And the vault really does cover every agent, so a new one cannot be added
  // without a fixture that proves it publishes.
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
      // Reasoning folds into the turn's own words, ahead of the text part it
      // preceded, exactly as a thinking block does for a file provider.
      role: 'assistant',
      text: 'Weighing which parts carry words.\nEvery part of every turn.',
      timestamp: expect.any(String)
    },
    {
      // The call line and what came back, in one message: OpenCode writes both
      // on one part where a file provider writes a call block and a result.
      role: 'tool',
      text: 'bash: rg --count quokka\nsrc/main/ai-vault: 3',
      timestamp: expect.any(String)
    }
  ])
})

it('gives an OpenCode session the same three roles a file provider publishes', async () => {
  const reads = await readEveryAgentVault()

  const sqliteRead = reads.find(
    (read) => splitOpenCodeSqliteCandidate(read.path)?.sessionId === OPENCODE_SQLITE_SESSION
  )
  expect(new Set(sqliteRead?.messages.map((message) => message.role))).toEqual(
    new Set(['user', 'assistant', 'tool'])
  )
})

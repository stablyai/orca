import { mkdtemp, rm, appendFile, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'
import { messageQuestionTranscriptGeneration } from './message-question-transcript-generation'
import { boundaryFingerprint } from './transcript-file-version'
import type { MessageQuestionSource } from './message-question-source'

let root: string
let filePath: string
let database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-question-source-'))
  filePath = join(root, 'rollout.jsonl')
  database = JournalHostDatabase.open(root)
  await writeFile(filePath, '{"id":"native-row"}\n')
})
afterEach(async () => {
  database.close()
  await rm(root, { recursive: true, force: true })
})

it('retains the saved generation through append/reopen but changes it when replacement can reuse offsets', async () => {
  const source: MessageQuestionSource = {
    kind: 'transcript',
    agent: 'codex',
    sessionId: 'source',
    filePath
  }
  const initial = await messageQuestionTranscriptGeneration(filePath, null)
  const file = {
    ...initial.version,
    offset: initial.version.size,
    boundary: await boundaryFingerprint(filePath, initial.version.size)
  }
  const repository = messageQuestionsFor(database)
  expect(
    repository.reconcile(source, [], {}, { generation: initial.generation, file }).writeError
  ).toBeUndefined()
  await appendFile(filePath, '{"id":"later-row"}\n')
  database.close()
  database = JournalHostDatabase.open(root)
  const saved = messageQuestionsFor(database).sourceState(source)
  const appended = await messageQuestionTranscriptGeneration(filePath, saved)
  expect(appended.replaced).toBe(false)
  expect(appended.generation).toBe(initial.generation)
  await writeFile(filePath, '{}\n')
  const truncated = await messageQuestionTranscriptGeneration(filePath, saved)
  expect(truncated.replaced).toBe(true)
  expect(truncated.generation).not.toBe(initial.generation)
  const replacement = join(root, 'replacement.jsonl')
  await writeFile(replacement, '{"id":"native-row"}\n')
  await rename(replacement, filePath)
  const rotated = await messageQuestionTranscriptGeneration(filePath, saved)
  expect(rotated.replaced).toBe(true)
  expect(rotated.generation).not.toBe(initial.generation)
})

it('does not treat a missing source as deletion or manufacture a new durable generation', async () => {
  const source: MessageQuestionSource = {
    kind: 'transcript',
    agent: 'codex',
    sessionId: 'source',
    filePath
  }
  const initial = await messageQuestionTranscriptGeneration(filePath, null)
  const state = {
    generation: initial.generation,
    file: {
      ...initial.version,
      offset: initial.version.size,
      boundary: await boundaryFingerprint(filePath, initial.version.size)
    }
  }
  const repository = messageQuestionsFor(database)
  repository.reconcile(source, [], {}, state)
  await rename(filePath, join(root, 'temporarily-missing.jsonl'))
  await expect(
    messageQuestionTranscriptGeneration(filePath, repository.sourceState(source))
  ).rejects.toThrow()
  expect(repository.sourceState(source)).toEqual(state)
})

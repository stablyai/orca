import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  PENDING_MESSAGE_QUESTION,
  type MessageQuestionOccurrence
} from '../../shared/message-question-occurrence'
import { deleteAiVaultSessionFile } from '../ai-vault/session-delete'
import {
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore
} from '../runtime/agent-session-record-store-slot'
import { createStructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { deleteTranscriptQuestionSource } from './message-question-source-deletion'
import { messageQuestionsFor } from './message-question-repository'
import {
  messageQuestionOccurrenceId,
  messageQuestionSourceId,
  type MessageQuestionSource
} from './message-question-source'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-question-deletion-'))
})
afterEach(async () => {
  const opened = await releaseAgentSessionRecordStore()
  opened?.journalDatabase.close()
  await rm(root, { recursive: true, force: true })
})
function location() {
  return {
    stateDirectory: join(root, 'host'),
    hostId: 'local',
    logger: createStructuredAgentSessionLogger()
  }
}
function occurrence(source: MessageQuestionSource): MessageQuestionOccurrence {
  const sourceId = messageQuestionSourceId(source)
  return {
    id: messageQuestionOccurrenceId(sourceId, 'root', 'row-1', 0),
    sourceId,
    context: 'root',
    sourceRowId: 'row-1',
    callSlot: 0,
    order: [1, 0],
    timestamp: null,
    turnId: null,
    responseMode: 'message',
    questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'Blue' }] }],
    resolution: PENDING_MESSAGE_QUESTION
  }
}
it.each([false, true])(
  'removes linkage only after approved file deletion, releasing its owner before removal (restarted=%s)',
  async (restarted) => {
    const projects = join(root, 'projects')
    const path = join(projects, 'project-1', 'session-1.jsonl')
    await mkdir(join(projects, 'project-1'), { recursive: true })
    await writeFile(path, '{}\n')
    const source: MessageQuestionSource = {
      kind: 'transcript',
      agent: 'claude',
      sessionId: 'actual-session',
      filePath: path
    }
    const other: MessageQuestionSource = {
      ...source,
      sessionId: 'other-session',
      filePath: join(projects, 'project-1', 'other.jsonl')
    }
    const opened = await openAgentSessionRecordStoreOnce(location())
    let repository = messageQuestionsFor(opened.journalDatabase)
    const record = occurrence(source)
    repository.reconcile(source, [record])
    repository.cancel(source, [record.id], 'phone', 10)
    repository.reconcile(other, [occurrence(other)])
    let released = false
    if (restarted) {
      const prior = await releaseAgentSessionRecordStore()
      prior?.journalDatabase.close()
    } else {
      repository.ownSource(source, () => {
        expect(repository.current(source).records).toHaveLength(1)
        released = true
      })
    }
    const deleted: string[] = []
    const remove = async (removal: { path: string; kind: 'file' | 'directory' }) => {
      deleted.push(removal.path)
      await rm(removal.path, { recursive: removal.kind === 'directory', force: true })
    }
    const cleanup = (agent: string, approvedPath: string) =>
      deleteTranscriptQuestionSource(agent, approvedPath, location())
    const args = {
      agent: 'claude' as const,
      filePath: path,
      sessionId: 'untrusted-wrong-session',
      executionHostId: 'local' as const,
      rootOptions: { claudeProjectsDir: projects }
    }
    const denied = await deleteAiVaultSessionFile(
      { ...args, executionHostId: 'ssh:other' },
      remove,
      cleanup
    )
    expect(denied.outcome).toBe('rejected')
    expect(deleted).toEqual([])
    expect(released).toBe(false)
    const result = await deleteAiVaultSessionFile(args, remove, cleanup)
    expect(result).toEqual({ outcome: 'deleted' })
    expect(deleted).toContain(path)
    if (!restarted) {
      expect(released).toBe(true)
    }
    repository = messageQuestionsFor(
      (await openAgentSessionRecordStoreOnce(location())).journalDatabase
    )
    expect(repository.current(source).records).toEqual([])
    expect(repository.current(other).pending).toHaveLength(1)
    // An idempotent owner retry neither recreates nor removes a sibling source.
    expect(await deleteAiVaultSessionFile(args, remove, cleanup)).toEqual({ outcome: 'deleted' })
    expect(repository.current(other).pending).toHaveLength(1)
  }
)

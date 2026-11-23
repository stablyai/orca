import { vi, type Mock } from 'vitest'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { readTestJournalItems } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  testEventSinkLogging,
  recordingStructuredAgentSessionLogger
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

const journals = createTrackedJournalOpener({ legacyInputs: true })
const cleanups: (() => Promise<void>)[] = []
export const SESSION = 'chat-catch-up'
export const PROVIDER = 'provider-catch-up'

export async function closeClaudeCatchUpChats() {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
}

export async function chat(
  mode: 'tail' | 'batch' | 'metadata' | 'uuidless-metadata' | 'system' = 'tail',
  providerSessionId = PROVIDER
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-catch-up-'))
  const config = join(root, 'claude')
  const project = join(config, 'projects', 'project')
  await mkdir(project, { recursive: true })
  const filePath = join(project, `${providerSessionId}.jsonl`)
  const file = await open(filePath, 'w')
  const row = (uuid: string, parentUuid: string | null, text: string, type = 'assistant') => ({
    type,
    uuid,
    parentUuid,
    sessionId: providerSessionId,
    timestamp: '2026-11-01T00:00:00.000Z',
    message: { role: type, id: uuid, content: [{ type: 'text', text }] }
  })
  try {
    await file.write(`${JSON.stringify(row('old-leaf', null, 'old answer'))}\n`)
    let parent = 'old-leaf'
    if (mode === 'tail' || mode === 'system') {
      for (let i = 0; i < 27; i++) {
        const boundary = `compact-${i}`
        await file.write(
          `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: boundary, parentUuid: null, logicalParentUuid: parent })}\n`
        )
        parent = `outside-${i}`
        await file.write(`${JSON.stringify(row(parent, boundary, 'x'.repeat(640 * 1024)))}\n`)
      }
    } else if (mode === 'batch') {
      for (let i = 0; i < 600; i++) {
        const prompt = `prompt-${i}`
        await file.write(`${JSON.stringify(row(prompt, parent, 'outside question', 'user'))}\n`)
        parent = `answer-${i}`
        await file.write(`${JSON.stringify(row(parent, prompt, 'outside answer'))}\n`)
      }
    }
    await file.write(
      `${JSON.stringify(row('newest-answer', parent, 'Distinctive newest outside answer'))}\n`
    )
    if (mode === 'metadata' || mode === 'uuidless-metadata') {
      const rows = mode === 'uuidless-metadata' ? 39 : 27
      for (let i = 0; i < rows; i++) {
        await file.write(
          `${JSON.stringify({ type: mode === 'metadata' ? 'progress' : 'file-history-snapshot', ...(mode === 'metadata' ? { uuid: `progress-${i}` } : {}), data: 'x'.repeat(640 * 1024) })}\n`
        )
      }
    }
    if (mode === 'system') {
      await file.write(
        `${JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'system-frontier', parentUuid: 'newest-answer' })}\n`
      )
    }
  } finally {
    await file.close()
  }
  const options = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle(providerSessionId, 'old-leaf')
    },
    stateDirectory: root
  }
  let journal = await journals.open(options)
  await journal.appendItem(
    { provider: 'claude', sessionId: providerSessionId, uuid: 'old-turn' },
    { kind: 'turn', turnId: 'old-turn', state: 'completed' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'claude', sessionId: providerSessionId, uuid: 'old-leaf' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'old answer' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.close()
  await closeTestJournalHostDatabase(root)
  journal = await journals.open({ ...options, recover: { fence: 1 } })
  const logging = recordingStructuredAgentSessionLogger()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(SESSION),
    logger: logging.logger
  })
  const publish: Mock<(...args: unknown[]) => void> = vi.fn()
  deferred.bind({ journal, fence: 1, publish })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  return {
    filePath,
    config,
    cwd: root,
    get journal() {
      return journal
    },
    appendGrowth: async () => {
      const file = await open(filePath, 'a')
      try {
        for (let i = 0; i < 27; i++) {
          await file.write(
            `${JSON.stringify({ type: 'file-history-snapshot', data: 'x'.repeat(640 * 1024) })}\n`
          )
        }
        await file.write(
          `${JSON.stringify(row('saved-later-leaf', 'newest-answer', 'Saved later answer'))}\n`
        )
      } finally {
        await file.close()
      }
      await journal.appendItem(
        { provider: 'claude', sessionId: providerSessionId, uuid: 'saved-later-leaf' },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Rich saved later answer' }]
        },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    },
    appendOutsideAnswer: async (parent = 'newest-answer') => {
      const file = await open(filePath, 'a')
      try {
        if (mode === 'system') {
          await file.write(
            `${JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'later-system', parentUuid: parent })}\n`
          )
          parent = 'later-system'
        }
        await file.write(`${JSON.stringify(row('later-answer', parent, 'Later outside answer'))}\n`)
      } finally {
        await file.close()
      }
    },
    logs: logging.entries,
    deferred,
    publish,
    reopen: async () => {
      deferred.unbind()
      await journal.close()
      await closeTestJournalHostDatabase(root)
      journal = await journals.open({ ...options, recover: { fence: 1 } })
      deferred.bind({ journal, fence: 1, publish })
    },
    catchUp: async (leafUuid = 'old-leaf') => {
      const input = {
        sessionId: SESSION,
        providerSessionId: providerSessionId,
        leafUuid,
        claudeConfigDir: config,
        cwd: root,
        sink: deferred.sink,
        logger: logging.logger
      }
      const outcome = await catchUpClaudeTranscript(input)
      return typeof outcome === 'object'
        ? await catchUpClaudeTranscript({
            ...input,
            mode: 'recovery',
            timeoutMs: outcome.deadline - Date.now()
          })
        : outcome
    },
    items: () => readTestJournalItems(journal)
  }
}

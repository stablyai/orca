import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  reduceStructuredAgentSession,
  EMPTY_STRUCTURED_AGENT_SESSION
} from '../../../../shared/structured-agent-session-reducer'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import type { openStream } from './structured-agent-session-rpc.test-fixture'
import { createHash } from 'node:crypto'
import recorded from './structured-agent-session-released-reader-record.test-fixture.json'
import { expect } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import type { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'

export function createQueuedImageWireRecord(
  root: string,
  sessionId: string,
  journal: () => AgentSessionJournal
) {
  const epochs = new Map<string, string>()
  const hashes = new Map<string, string>()
  const attempts = new Map<string, string>()
  const records: unknown[] = []
  const witnesses: unknown[] = []
  function paths(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replaceAll(root, '<host-root>')
    }
    if (Array.isArray(value)) {
      return value.map(paths)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, paths(child)]))
    }
    return value
  }
  function normalize(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
      if (key === 'epoch') {
        if (!epochs.has(value)) {
          epochs.set(value, `<epoch:${epochs.size}>`)
        }
        return epochs.get(value)
      }
      if (hashes.has(value)) {
        return hashes.get(value)
      }
      let result = value
      if (
        [
          'clientMessageId',
          'itemId',
          'removedItemIds',
          'messageId',
          'queuedMessageId',
          'keptAsQueuedMessageId',
          'recovers',
          'consumedAs'
        ].includes(key)
      ) {
        for (const [id, token] of attempts) {
          result = result.replaceAll(id, token)
        }
      }
      return paths(result)
    }
    if (Array.isArray(value)) {
      return value.map((child) => normalize(child, key))
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, child]) => [name, normalize(child, name)])
      )
    }
    return value
  }
  function record(value: unknown) {
    const state = journal()
    for (const submission of state.submissions()) {
      if (submission.queuedMessageId && !attempts.has(submission.clientMessageId)) {
        attempts.set(submission.clientMessageId, `<queued-attempt:${attempts.size}>`)
      }
      const body = state.submissionBody(submission.clientMessageId)
      if (!body) {
        continue
      }
      expect(submission.payloadFingerprint).toBe(agentSessionSendBodyFingerprint(sessionId, body))
      const normalizedBody = JSON.parse(JSON.stringify(paths(body)))
      hashes.set(
        submission.payloadFingerprint,
        agentSessionSendBodyFingerprint(sessionId, normalizedBody)
      )
    }
    for (const card of state.queuedMessages.list()) {
      expect(card.fingerprint).toBe(agentSessionSendBodyFingerprint(sessionId, card.body))
      hashes.set(
        card.fingerprint,
        agentSessionSendBodyFingerprint(sessionId, JSON.parse(JSON.stringify(paths(card.body))))
      )
    }
    const normalized = normalize(value)
    records.push(normalized)
    witnesses.push(
      normalize({
        cursor: state.cursor(),
        submissions: state.submissions().map((submission) => ({
          submission,
          body: state.submissionBody(submission.clientMessageId),
          receipt: state.receiptFor(submission.clientMessageId)
        })),
        choices: state.queuedMessages.list()
      })
    )
    return normalized
  }
  return {
    record,
    normalize,
    records,
    witnesses,
    verify() {
      const tuples = new Map(Object.entries(recorded.tuples))
      const expected = new Map(Object.entries(recorded.tests)).get(
        expect.getState().currentTestName ?? ''
      )
      expect(expected, 'missing deliberately recorded released-reader class').toBeDefined()
      expect(
        records.map((value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'))
      ).toStrictEqual(expected?.map((row) => tuples.get(row)?.inputSha256))
      expect(
        witnesses.map((value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'))
      ).toStrictEqual(expected?.map((row) => tuples.get(row)?.canonicalSha256))
    }
  }
}

export function streamState(frames: Awaited<ReturnType<typeof openStream>>) {
  return frames.reduce((state, frame) => {
    if (!frame.ok) {
      throw new Error('subscription failed')
    }
    if (!frame.result) {
      return state
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the installed subscribe dispatcher writes these serialized events.
    const event = frame.result as AgentSessionSubscribeEvent
    return reduceStructuredAgentSession(state, { type: 'event', event })
  }, EMPTY_STRUCTURED_AGENT_SESSION)
}

export async function queuedImageTestBody(
  root: string,
  text = 'original'
): Promise<AgentJournalMessageItem> {
  const dir = join(agentSessionAttachmentStoreRoot(root), '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0a')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'shot.png')
  await writeFile(path, 'fixture image bytes')
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      { type: 'image-ref', path }
    ]
  }
}

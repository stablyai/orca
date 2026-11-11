import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  ptyChatSubmissionSummary,
  structuredChatSubmissionSummary
} from './native-chat-submission-summary'

it.each([1_000, 10_000])('finds an earlier submission in a %i-item journal', (length) => {
  const items: AgentJournalRenderItem[] = Array.from({ length }, (_, index) => ({
    itemId: `message-${index}`,
    sequence: index + 1,
    revision: 1,
    observedAt: index,
    body: {
      kind: 'message',
      role: index === 0 ? 'user' : 'assistant',
      blocks: [{ type: 'text', text: 'Conversation' }]
    }
  }))
  const snapshot: AgentJournalSnapshot = {
    sessionId: 'conversation',
    cursor: { epoch: 'original', sequence: length },
    items,
    submissions: []
  }
  expect(
    structuredChatSubmissionSummary(snapshot, { epoch: 'original', sequence: length })
      .hasPriorSubmission
  ).toBe(true)
  expect(
    structuredChatSubmissionSummary(snapshot, { epoch: 'original', sequence: 1 }).hasPriorSubmission
  ).toBe(false)
  expect(
    structuredChatSubmissionSummary(snapshot, { epoch: 'replaced', sequence: length })
      .hasPriorSubmission
  ).toBe(false)
})

it('does not count unconfirmed or command submissions', () => {
  const snapshot: AgentJournalSnapshot = {
    sessionId: 'conversation',
    cursor: { epoch: 'original', sequence: 10 },
    items: [
      {
        itemId: 'orca:pending',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Unconfirmed request' }]
        }
      },
      {
        itemId: 'command',
        sequence: 2,
        revision: 1,
        observedAt: 2,
        body: { kind: 'message', role: 'user', command: { name: 'compact' }, blocks: [] }
      }
    ],
    submissions: [
      {
        clientMessageId: 'pending',
        fence: 1,
        payloadFingerprint: 'pending',
        dispatchState: 'unknown',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
  }
  expect(
    structuredChatSubmissionSummary(snapshot, { epoch: 'original', sequence: 10 })
      .hasPriorSubmission
  ).toBe(false)
})

it('scans a long transcript before its captured anchor without counting the new send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-submission-summary-'))
  try {
    const transcriptPath = join(directory, 'transcript.jsonl')
    const line = (id: string, role: 'user' | 'assistant') =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', id, role, content: [{ type: 'text', text: 'Conversation' }] }
      })
    const tail = Array.from({ length: 2_000 }, (_, index) =>
      line(`assistant-${index}`, 'assistant')
    )
    const args = {
      agent: 'codex',
      sessionId: 'conversation',
      transcriptPath,
      anchorId: 'assistant-1999'
    }
    await writeFile(transcriptPath, `${[...tail, line('new-send', 'user')].join('\n')}\n`)
    expect((await ptyChatSubmissionSummary(args)).hasPriorSubmission).toBe(false)
    await writeFile(
      transcriptPath,
      `${[line('initial-request', 'user'), ...tail, line('new-send', 'user')].join('\n')}\n`
    )
    expect((await ptyChatSubmissionSummary(args)).hasPriorSubmission).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('finds a custom skill before the anchor while excluding catalog commands and later prompts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-skill-submission-summary-'))
  try {
    const transcriptPath = join(directory, 'transcript.jsonl')
    const line = (id: string, role: 'user' | 'assistant', text: string) =>
      JSON.stringify({ type: role, uuid: id, message: { role, content: text } })
    const skill = line(
      'custom-skill',
      'user',
      '<command-name>/review-design</command-name><command-args>the composer</command-args>'
    )
    const tail = Array.from({ length: 600 }, (_, index) =>
      line(`assistant-${index}`, 'assistant', 'Conversation')
    )
    const args = {
      agent: 'claude',
      sessionId: 'conversation',
      transcriptPath,
      anchorId: 'assistant-599'
    }
    const command = line('compact', 'user', '<command-name>/compact</command-name>')
    await writeFile(transcriptPath, `${[command, ...tail, skill].join('\n')}\n`)
    expect((await ptyChatSubmissionSummary(args)).hasPriorSubmission).toBe(false)
    await writeFile(transcriptPath, `${[skill, ...tail].join('\n')}\n`)
    expect((await ptyChatSubmissionSummary(args)).hasPriorSubmission).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

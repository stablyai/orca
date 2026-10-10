// Pins that slash-prefixed text, exactly as a `/` menu pick inserts it, retires its
// pending bubble against the host's submission row. Composes the real shared stream
// reducer, the phone's transcript projection, origin capture, the structured send
// bridge and pending retirement, with only the RPC/provider boundary faked.

import { createElement, useCallback, useMemo, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-send-mutation'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../src/shared/structured-agent-session-reducer'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

type Api = {
  drafts: ReturnType<typeof useMobileNativeChatDrafts>
  bridge: ReturnType<typeof useMobileStructuredNativeChatSendBridge>
  messages: NativeChatMessage[]
  deliver: (event: AgentSessionSubscribeEvent) => void
}

let api: Api | null = null
let renderer: ReactTestRenderer | null = null
let resolveSend: ((outcome: MobileNativeChatSendOutcome) => void) | null = null
let sequence = 0
const onSendError = vi.fn()
const sendStructured = vi.fn(
  (_text: string, _images?: string[], _deadline?: number, _attachments?: unknown) =>
    new Promise<MobileNativeChatSendOutcome>((resolve) => {
      resolveSend = resolve
    })
)

function Harness(): null {
  const [session, setSession] = useState(EMPTY_STRUCTURED_AGENT_SESSION)
  const deliver = useCallback((event: AgentSessionSubscribeEvent) => {
    setSession((previous) =>
      reduceStructuredAgentSession(previous, { type: 'event', event }, Date.now())
    )
  }, [])
  // The same projection the phone's structured session hook renders from.
  const messages = useMemo(
    () =>
      projectStructuredAgentSessionMessages(session.items, [], session.submissions, {
        rejectedInPlace: false
      }),
    [session.items, session.submissions]
  )
  const drafts = useMobileNativeChatDrafts({
    hostId: 'host',
    worktreeId: 'worktree',
    tabId: 'tab',
    sessionId: 'session-1',
    messages,
    transcriptSettled: session.status === 'ready'
  })
  const bridge = useMobileStructuredNativeChatSendBridge({
    agent: 'claude',
    sendStructured,
    captureSendOrigin: drafts.captureSendOrigin,
    clearDraftForSend: drafts.clearDraftForSend,
    acceptSend: drafts.acceptSend,
    holdUnconfirmedSend: drafts.holdUnconfirmedSend,
    restoreRejectedDraft: drafts.restoreRejectedDraft,
    onSendError
  })
  api = { drafts, bridge, messages, deliver }
  return null
}

function current(): Api {
  if (!api) {
    throw new Error('harness not mounted')
  }
  return api
}

function snapshot(): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

function batch(
  parts: {
    items?: AgentJournalRenderItem[]
    submissions?: AgentJournalSubmission[]
  } = {}
): AgentSessionSubscribeEvent {
  sequence += 1
  return {
    type: 'batch',
    sessionId: 'session-1',
    fence: 3,
    batch: {
      cursor: { epoch: 'epoch-1', sequence },
      items: parts.items ?? [],
      removedItemIds: [],
      submissions: parts.submissions ?? []
    }
  }
}

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 3,
    payloadFingerprint: `fingerprint-${clientMessageId}`,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: 11,
    ...overrides
  }
}

/** The host's write-ahead row: the submitted body, which doubles as the user bubble. */
function submissionRow(
  clientMessageId: string,
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[] = []
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: structuredAgentSessionSendBody(text, attachments)
  }
}

function assistantReply(text: string): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `assistant-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

/** What the transcript shows as the user's turns: journal rows plus pending bubbles. */
function renderedUserTurns(): string[] {
  const { messages, drafts } = current()
  const rows = messages
    .filter((message) => message.role === 'user' && !message.queued)
    .map((message) =>
      message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    )
  return [...rows, ...drafts.pending.map((pending) => pending.text)]
}

async function mountSession(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  act(() => current().deliver(snapshot()))
}

/** Puts the slash text (a picked token plus any arguments) in the box and starts the send. */
async function sendSlashText(
  draft: string,
  images?: string[],
  attachments?: readonly StructuredAgentSessionAttachment[]
): Promise<{ sent: Promise<MobileNativeChatSendOutcome> }> {
  act(() => current().drafts.setComposerText(draft))
  let sent!: Promise<MobileNativeChatSendOutcome>
  await act(async () => {
    sent =
      attachments !== undefined
        ? current().bridge.sendWithOutcome(draft, images, undefined, attachments)
        : current().bridge.sendWithOutcome(draft)
    await Promise.resolve()
  })
  expect(current().drafts.composerText).toBe('')
  // Wrapped: an async function returning the bare promise would wait for it.
  return { sent }
}

async function settle(
  sent: Promise<MobileNativeChatSendOutcome>,
  outcome: MobileNativeChatSendOutcome
): Promise<void> {
  await act(async () => {
    resolveSend?.(outcome)
    await sent
  })
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  api = null
  resolveSend = null
  sequence = 0
  vi.clearAllMocks()
})

describe('slash-prefixed text, as a `/` menu pick inserts it', () => {
  const cases = [
    { name: 'a command token', draft: '/review ', reply: true },
    { name: 'a skill token with arguments', draft: '/my-skill args', reply: true },
    { name: 'a command whose only journal row is its submission', draft: '/context', reply: false },
    { name: 'a draft with trailing whitespace and a newline', draft: '/review src \n', reply: true }
  ]
  for (const ordering of ['stream before the accepted callback', 'accepted callback first']) {
    it.each(cases)(
      `retires its pending bubble against the host row: $name (${ordering})`,
      async (entry) => {
        await mountSession()
        const { sent } = await sendSlashText(entry.draft)
        const landed = entry.draft.trimEnd()
        const host = batch({
          items: [submissionRow('send-1', entry.draft)],
          submissions: [submission('send-1')]
        })
        if (ordering === 'accepted callback first') {
          await settle(sent, 'accepted')
          expect(current().drafts.pending.map((pending) => pending.text)).toEqual([landed])
          act(() => current().deliver(host))
        } else {
          act(() => current().deliver(host))
          await settle(sent, 'accepted')
        }
        if (entry.reply) {
          act(() => current().deliver(batch({ items: [assistantReply('Done.')] })))
        }

        expect(current().drafts.pending).toEqual([])
        expect(renderedUserTurns()).toEqual([landed])
        expect(onSendError).not.toHaveBeenCalled()
      }
    )
  }

  it('hands a skill token’s image preview to its host row', async () => {
    await mountSession()
    const attachments = [{ path: '/host/upload/shot.png', previewUri: 'file:///local/shot.png' }]
    const { sent } = await sendSlashText('/my-skill look', ['file:///local/shot.png'], attachments)
    await settle(sent, 'accepted')
    expect(current().drafts.pending.map((pending) => pending.images)).toEqual([
      ['file:///local/shot.png']
    ])

    act(() =>
      current().deliver(
        batch({
          items: [submissionRow('send-1', '/my-skill look', attachments)],
          submissions: [submission('send-1')]
        })
      )
    )

    expect(current().drafts.pending).toEqual([])
    expect(renderedUserTurns()).toEqual(['/my-skill look'])
    expect(current().drafts.imagePreviewsByMessageId).toEqual({
      [agentJournalSubmissionKey('send-1')]: ['file:///local/shot.png']
    })
  })

  it('shows queued slash text only once the host hands it over', async () => {
    await mountSession()
    const { sent } = await sendSlashText('/review ')
    await settle(sent, 'queued')
    expect(current().drafts.pending).toEqual([])

    const queued = { handoverRecorded: true as const, queuedMessageId: 'queued-1' }
    act(() =>
      current().deliver(
        batch({
          items: [submissionRow('send-1', '/review ')],
          submissions: [
            submission('send-1', { ...queued, dispatchState: 'pending', resolvedAt: null })
          ]
        })
      )
    )
    expect(renderedUserTurns()).toEqual([])
    act(() =>
      current().deliver(
        batch({ submissions: [submission('send-1', { ...queued, handedOverAt: 12 })] })
      )
    )

    expect(current().drafts.pending).toEqual([])
    expect(renderedUserTurns()).toEqual(['/review'])
  })
})

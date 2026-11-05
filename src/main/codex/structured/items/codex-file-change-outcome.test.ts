import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isAdmissibleAgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/agent-session/structured-agent-session-reducer'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  nativeChatTurnDiffEditFile,
  nativeChatTurnDiffs
} from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentJournalItemForWire } from '../../../native-chat/agent-session-wire/agent-session-item-wire-form'
import {
  createCodexHistoryTranslator,
  createCodexJournalTranslator
} from '../journal/codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const disposers: (() => void)[] = []
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()))
const patch = '@@ -1 +1 @@\n-old\n+new'
// Protocol shape also exercised by codex-structured-reasoning-lifecycle.test.ts; no real CLI run is claimed.
const change = (status?: string) => ({
  type: 'fileChange',
  id: 'patch',
  ...(status ? { status } : {}),
  changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: patch }]
})

function fixture() {
  let sequence = 0
  let state: StructuredAgentSessionState = { ...EMPTY_STRUCTURED_AGENT_SESSION, epoch: 'epoch' }
  const apply = (items: AgentJournalRenderItem[]) => {
    state = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session',
        batch: {
          cursor: { epoch: 'epoch', sequence: ++sequence },
          items,
          removedItemIds: [],
          submissions: []
        }
      }
    })
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => {
      const itemId = agentJournalItemKey(identity)
      const previous = state.items.find((item) => item.itemId === itemId)
      apply([
        agentJournalItemForWire({
          itemId,
          body,
          revision: (previous?.revision ?? 0) + 1,
          sequence: previous?.sequence ?? sequence + 1,
          observedAt: options.observedAt ?? 1
        }).item
      ])
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  const live = createCodexJournalTranslator({ sink, schedule: () => () => {} })
  const history = createCodexHistoryTranslator({ sink })
  disposers.push(live.dispose, history.dispose)
  const send = (method: string, params: unknown) =>
    live.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params
    } satisfies CodexStructuredSessionEvent)
  const outcome = () => {
    const messages = projectStructuredItemsToNativeChat(state.items)
    return nativeChatTurnDiffs(
      messages,
      messages.map(() => 'turn')
    ).get('turn')
  }
  return {
    live,
    history,
    send,
    outcome,
    replay: () => {
      const items = state.items.map((item) => {
        const restored: unknown = JSON.parse(JSON.stringify(item))
        if (!isAdmissibleAgentJournalRenderItem(restored)) {
          throw new Error('Journal item failed replay validation')
        }
        return restored
      })
      state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
        type: 'history-page',
        page: {
          sessionId: 'session',
          epoch: 'epoch',
          direction: 'tail',
          items,
          submissions: [],
          removedItemIds: [],
          hasOlder: false,
          hasNewer: false,
          liveCursor: { epoch: 'epoch', sequence },
          window: {
            oldest: null,
            newest: null,
            nextCursor: { epoch: 'epoch', sequence: 0 }
          }
        }
      })
    }
  }
}

it('shows one landed patch only after completion, including stream updates and replay revisions', () => {
  const f = fixture()
  f.send('item/started', { item: change('inProgress') })
  expect(f.outcome()).toBeUndefined()
  f.send('item/fileChange/outputDelta', {
    itemId: 'patch',
    delta: '@@ -1 +1 @@\n-stdout\n+not-a-patch'
  })
  f.send('item/fileChange/patchUpdated', { itemId: 'patch', changes: change().changes })
  f.live.flush()
  expect(f.outcome()).toBeUndefined()
  f.send('item/completed', { item: change('completed') })
  f.live.flush()
  expect(f.outcome()?.files.map((file) => file.path)).toEqual(['src/app.ts'])
  expect(f.outcome()).toMatchObject({ added: 1, removed: 1 })
  expect(f.outcome()?.files[0]?.edits).toHaveLength(1)
  expect(nativeChatTurnDiffEditFile(f.outcome()!.files[0]!.edits[0]!)).toMatchObject({
    path: 'src/app.ts',
    added: 1,
    removed: 1
  })
  f.replay()
  f.send('item/completed', { item: change('completed') })
  expect(f.outcome()?.files[0]?.edits).toHaveLength(1)
  expect(f.outcome()).toMatchObject({ added: 1, removed: 1 })
})

it.each(['failed', 'declined', 'inProgress', undefined])(
  'never promotes %s changes via a completion wrapper or history import',
  (status) => {
    const f = fixture()
    f.send('item/started', { item: change('inProgress') })
    f.send('item/completed', { item: change(status) })
    expect(f.outcome()).toBeUndefined()
    f.history.restoreThread('thread', {
      turns: [{ id: 'turn', status: 'completed', items: [change(status)] }]
    })
    expect(f.outcome()).toBeUndefined()
    f.replay()
    expect(f.outcome()).toBeUndefined()
  }
)

it('keeps an orphan patch update unconfirmed and settles buffered stdout without a landed file', () => {
  const f = fixture()
  f.send('item/fileChange/patchUpdated', { itemId: 'patch', changes: change().changes })
  f.live.flush()
  expect(f.outcome()).toBeUndefined()
  f.send('item/started', { item: change('inProgress') })
  f.send('item/fileChange/outputDelta', { itemId: 'patch', delta: patch })
  f.live.handle({ type: 'ended', sessionId: 'session', reason: 'app-server exited' })
  expect(f.outcome()).toBeUndefined()
  f.replay()
  expect(f.outcome()).toBeUndefined()
})

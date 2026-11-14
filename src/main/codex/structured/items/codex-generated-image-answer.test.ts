import { expect, it } from 'vitest'
import { chat, SESSION, THREAD, turn } from '../threads/codex-thread-catch-up-contract-test-fixture'
import { codexNonMessageIdentity } from './codex-thread-item-identity'
import { codexTurnLifecycleIdentity } from '../journal/codex-structured-journal-translation-turns'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { nativeChatGeneratedImageAnswers } from '../../../../shared/native-chat/transcript/images/native-chat-generated-image-answers'

it.each(['complete', 'sparse'])(
  'enriches %s authoritative saved generation once and preserves the result through replay',
  async (shape) => {
    const c = await chat({ now: 1000 })
    const identity = codexNonMessageIdentity(THREAD, 'turn-1', 'image-1')
    const key = agentJournalItemKey(identity)
    const turnIdentity = codexTurnLifecycleIdentity(SESSION, 'turn-1')
    await c.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'turn-1', state: 'completed', outcome: 'success' },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    await c.journal.appendItem(
      identity,
      {
        kind: 'message',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Generated image' },
          { type: 'image-ref', path: '/tmp/elephant.png' }
        ]
      },
      { fence: 1, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnIdentity) } }
    )
    const supplied = {
      ...turn(1),
      items: [
        {
          type: 'imageGeneration',
          id: 'image-1',
          ...(shape === 'complete' ? { status: 'completed', savedPath: '/tmp/elephant.png' } : {})
        },
        { type: 'agentMessage', id: 'answer', text: 'Here is your elephant.' }
      ]
    }
    await c.open([], { returnedTurns: [supplied], paginate: false })
    const saved = c.journal.item(key)!
    expect(saved.body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Generated image', presentation: 'generated-image' },
        { type: 'image-ref', path: '/tmp/elephant.png' }
      ]
    })
    const messages = projectStructuredItemsToNativeChat(c.journal.snapshot().items)
    const projected = nativeChatGeneratedImageAnswers(
      messages,
      messages.map(() => 'turn-1'),
      new Set(['turn-1']),
      () => []
    )
    expect(
      projected.find((row) =>
        row.blocks.some((block) => block.type === 'text' && block.text === 'Here is your elephant.')
      )?.blocks
    ).toEqual([
      { type: 'text', text: 'Here is your elephant.' },
      { type: 'image-ref', path: '/tmp/elephant.png' }
    ])
    await c.open([], { returnedTurns: [supplied], paginate: false })
    expect(c.journal.item(key)).toEqual(saved)
  }
)

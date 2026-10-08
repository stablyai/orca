import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { adapterFor, fakeCodex, identityFor } from './codex-structured-session-adapter-fixture'
import { CODEX_THREAD_FORK_CAPTURE } from './codex-thread-fork-reply.test-fixture'

const { parentThreadId, reply } = CODEX_THREAD_FORK_CAPTURE
const [forkedTurn] = reply.thread.turns
const forkFrom = { threadId: parentThreadId, lastTurnId: forkedTurn.id }

function journalSink(identities: AgentJournalItemIdentity[]): StructuredAgentSessionEventSink {
  return {
    appendItem: (identity) => identities.push(identity),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
}

describe('a Codex session that opens as a fork', () => {
  it('copies the parent through the chosen turn and journals the copy under its own thread', async () => {
    const codex = fakeCodex({ 'thread/fork': () => reply })
    const identities: AgentJournalItemIdentity[] = []

    const acquisition = await adapterFor(codex, { forkFrom }).acquire({
      identity: identityFor('session-1'),
      fence: 1,
      spawnToken: 'spawn-1',
      events: journalSink(identities)
    })

    expect(codex.connections[0].calls[0]).toEqual({
      method: 'thread/fork',
      params: { threadId: parentThreadId, lastTurnId: forkedTurn.id, cwd: '/work/repo' }
    })
    // Adopted, so a later resume never treats the copy as a creation Codex might not have saved.
    expect(acquisition.link).toMatchObject({
      origin: 'adopted',
      handle: codexProviderHandle(reply.thread.id)
    })
    // Messages keep Codex's own turn id under the copy's thread, so a later rewind or fork of an
    // inherited turn names something Codex knows; nothing is keyed by the parent.
    expect(identities).toContainEqual({
      provider: 'codex',
      threadId: reply.thread.id,
      turnId: forkedTurn.id,
      ordinal: 0
    })
    expect(identities).toContainEqual(
      expect.objectContaining({ recordId: `turn-lifecycle:${forkedTurn.id}` })
    )
    expect(identities).toHaveLength(forkedTurn.items.length + 1)
    expect(JSON.stringify(identities)).not.toContain(parentThreadId)
  })

  it('refuses a reply that names the parent, which would make it a second writer there', async () => {
    const codex = fakeCodex({ 'thread/fork': () => ({ thread: { id: parentThreadId } }) })

    await expect(
      adapterFor(codex, { forkFrom }).acquire({
        identity: identityFor('session-1'),
        fence: 1,
        spawnToken: 'spawn-1'
      })
    ).rejects.toThrow(`forked ${parentThreadId} onto itself`)
  })
})

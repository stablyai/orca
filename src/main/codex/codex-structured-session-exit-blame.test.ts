// Only the Codex app-server child's own exit says Codex stopped; a close Orca made — a journal
// sink that could not take a frame, a forced close — is Orca's.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { adapterFor, fakeCodex, identityFor } from './codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'

function sink(overrides: Partial<StructuredAgentSessionEventSink> = {}) {
  return { appendItem: vi.fn(), appendTombstone: vi.fn(), publish: vi.fn(), ...overrides }
}

async function startedCodex(events: StructuredAgentSessionEventSink) {
  const codex = fakeCodex()
  const emitted: CodexStructuredSessionEvent[] = []
  const adapter = adapterFor(codex, {}, emitted)
  await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 's', events })
  const ended = async () => {
    await vi.waitFor(() => expect(emitted.some((event) => event.type === 'ended')).toBe(true))
    return emitted.filter((event) => event.type === 'ended')
  }
  return { adapter, connection: codex.connections[0], ended }
}

describe('what a started Codex session says ended it', () => {
  it('says Codex stopped when the child exits on its own', async () => {
    const { connection, ended } = await startedCodex(sink())

    connection.handlers.onExit?.(new Error('codex app-server connection ended: killed'))

    const [event] = await ended()
    expect(event).toMatchObject({ cause: 'unexpected-exit', failure: { kind: 'providerExited' } })
    const failure = event && 'failure' in event ? event.failure : undefined
    expect(
      failure && agentSessionFailureWords(failure, { surface: 'row', agentName: 'Codex' }).text
    ).toBe(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
  })

  it('blames Orca when a journal sink failure makes Orca close the child', async () => {
    const { connection, ended } = await startedCodex(
      sink({ tryAppendItem: () => ({ accepted: false, reason: 'failed' }) })
    )

    connection.handlers.onUnhandledFrame?.('frame:invalid-json', '{')

    expect(await ended()).toMatchObject([
      {
        reason: 'Codex provider frame frame:invalid-json could not be durably recorded (failed)',
        cause: 'unexpected-exit',
        failure: { kind: 'hostFault' }
      }
    ])
    expect(connection.closeCount).toBe(1)
  })

  it('blames Orca for a forced close', async () => {
    const { adapter, ended } = await startedCodex(sink())

    await expect(adapter.forceCloseSession('session-1')).resolves.toBe(true)

    expect(await ended()).toMatchObject([
      { cause: 'unexpected-exit', failure: { kind: 'hostFault' } }
    ])
  })
})

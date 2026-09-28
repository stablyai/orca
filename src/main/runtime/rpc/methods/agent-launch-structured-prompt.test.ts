/**
 * The commit half of launch-prompt delivery: what the host sends, and what it is willing to claim.
 *
 * The assertions that matter are that the send is shaped like every other client's — the entry's
 * operation id IS the client message id, and the fingerprint is computed over the same body — and
 * that no failure mode can return an id, because an id is what the caller reads as "committed".
 */

import { describe, expect, it, vi } from 'vitest'
import { commitStructuredAgentSessionLaunchPrompt } from './agent-launch-structured-prompt'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

const CALLER = { callerKey: 'trusted-local:runtime' }

function hostWith(
  send: ReturnType<typeof vi.fn>,
  journalSnapshot: ReturnType<typeof vi.fn> = vi.fn(() => ({ submissions: [] }))
): StructuredAgentSessionHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the only method this module reaches; any other would throw rather than read a wrong value.
  return { send, journalSnapshot } as unknown as StructuredAgentSessionHost
}

function commit(host: StructuredAgentSessionHost | null, text = 'do the thing') {
  return commitStructuredAgentSessionLaunchPrompt({
    host,
    caller: CALLER,
    sessionId: 'sess-1',
    fence: 4,
    text
  })
}

describe('committing a launch prompt', () => {
  it('sends the entry as its own client message id and names the committed row', async () => {
    const send = vi.fn(async (_caller, params) => ({
      ok: true as const,
      value: { clientMessageId: params.envelope.clientOperationId, submission: {} }
    }))

    const messageId = await commit(hostWith(send))

    const [caller, params] = send.mock.calls[0]
    expect(caller).toEqual(CALLER)
    expect(messageId).toBe(params.envelope.clientOperationId)
    expect(params.envelope).toMatchObject({ sessionId: 'sess-1', expectedRuntimeFence: 4 })
    expect(params.body).toEqual(structuredAgentSessionSendBody('do the thing', []))
    // The host recomputes and compares this, so a launch send must fingerprint like a client send.
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'sess-1',
        fields: { body: params.body }
      })
    )
  })

  it('claims nothing when the send is refused', async () => {
    const send = vi.fn(async () => ({
      ok: false as const,
      refusal: { code: 'agent_session_operation_invalid', message: 'no' }
    }))
    await expect(commit(hostWith(send))).resolves.toBeNull()
  })

  it('recovers a committed row when settlement throws after append', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clientMessageId = ''
    const send = vi.fn(
      async (_caller: unknown, params: { envelope: { clientOperationId: string } }) => {
        clientMessageId = params.envelope.clientOperationId
        throw new Error('host gone')
      }
    )
    const journalSnapshot = vi.fn((_sessionId) => ({
      submissions: [{ clientMessageId }]
    }))
    await expect(commit(hostWith(send, journalSnapshot))).resolves.toEqual(clientMessageId)
  })

  it('claims nothing, and does not fail the launch, when no row was committed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const send = vi.fn(async () => {
      throw new Error('host gone')
    })
    await expect(commit(hostWith(send))).resolves.toBeNull()
  })

  it('sends nothing when there is no host or no text', async () => {
    const send = vi.fn()
    await expect(commit(null)).resolves.toBeNull()
    await expect(commit(hostWith(send), '   ')).resolves.toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})

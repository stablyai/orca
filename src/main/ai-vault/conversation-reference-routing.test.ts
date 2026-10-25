import { describe, expect, it, vi } from 'vitest'
import { forwardConversationReference } from './conversation-reference-routing'
import { conversationReferenceUri } from '../../shared/conversation-reference'

const remote = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: remote.call
}))

const reference = conversationReferenceUri(
  '12345678-1234-4234-8234-123456789abc',
  'runtime:source-host'
)

describe('remote conversation references', () => {
  it('reports old hosts instead of silently reading a broader source', async () => {
    remote.call.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'unknown' }
    })
    await expect(forwardConversationReference('conversation.read', { reference })).rejects.toThrow(
      'Update the source Orca host'
    )
    expect(remote.call.mock.calls.at(-1)?.[3]).toEqual({ reference, localOnly: true })
  })

  it('checks the remote page shape before giving it to the viewer or agent', async () => {
    remote.call.mockResolvedValue({ ok: true, result: { messages: 'invalid result' } })
    await expect(forwardConversationReference('conversation.read', { reference })).rejects.toThrow()
    remote.call.mockResolvedValue({
      ok: true,
      result: {
        reference: { uri: reference, title: 'Source', agent: 'codex' },
        messages: [],
        nextCursor: null,
        warnings: []
      }
    })
    await expect(
      forwardConversationReference('conversation.read', { reference })
    ).resolves.toMatchObject({ reference: { uri: reference }, messages: [] })
  })

  it('does not treat another host local path as a local source', async () => {
    await expect(
      forwardConversationReference('conversation.read', {
        reference: conversationReferenceUri('12345678-1234-4234-8234-123456789abc')
      })
    ).rejects.toThrow('not available on this host')
  })
})

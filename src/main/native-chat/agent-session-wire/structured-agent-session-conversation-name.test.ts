import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { StructuredAgentSessionConversationNames } from './structured-agent-session-conversation-name'

const SESSION = 'session-1'

function harness(
  stored: { conversationName?: string; conversationNamingAttempted?: boolean } = {},
  options: { failWrites?: boolean } = {}
) {
  const record = { ...stored }
  const applyConversationNaming = vi.fn(
    async (_sessionId: string, change: { conversationName?: string | null; attempted?: true }) => {
      if (options.failWrites) {
        throw new Error('agent_session_identity_required')
      }
      if (change.conversationName === null) {
        delete record.conversationName
      } else if (change.conversationName !== undefined) {
        record.conversationName = change.conversationName
      }
      if (change.attempted) {
        record.conversationNamingAttempted = true
      }
      return {} as AgentSessionRecord
    }
  )
  const onChanged = vi.fn()
  const onError = vi.fn()
  const names = new StructuredAgentSessionConversationNames({
    store: {
      getRecord: () => record as AgentSessionRecord,
      applyConversationNaming: applyConversationNaming as never
    },
    now: () => 5,
    onChanged,
    onError
  })
  return { names, onChanged, onError, applyConversationNaming, record }
}

describe('StructuredAgentSessionConversationNames', () => {
  it('persists a published name and announces the change once', async () => {
    const { names, onChanged, record } = harness()

    await names.publish(SESSION, '  Fix the\nlease probe ')

    expect(record.conversationName).toBe('Fix the lease probe')
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the lease probe')
  })

  it('does not rewrite or re-announce a name the record already holds', async () => {
    const { names, onChanged, applyConversationNaming } = harness({
      conversationName: 'Fix the lease probe'
    })

    await names.publish(SESSION, 'Fix the lease probe')

    expect(applyConversationNaming).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('ignores a report that carries no usable name', async () => {
    const { names, onChanged, applyConversationNaming } = harness()

    await names.publish(SESSION, '')
    await names.publish(SESSION, null)
    await names.publish(SESSION, { name: 'nope' })

    expect(applyConversationNaming).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('clears a name the provider says is gone, and announces the clear', async () => {
    const { names, onChanged, record } = harness({ conversationName: 'Fix the lease probe' })

    await names.clear(SESSION)

    // A name the user deleted elsewhere must not linger here and keep rendering.
    expect(record.conversationName).toBeUndefined()
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(SESSION, null)
  })

  it('records the attempt durably, and reads it back', async () => {
    const { names, record } = harness()

    expect(names.read(SESSION).namingAttempted).toBe(false)
    await names.markAttempted(SESSION)

    expect(record.conversationNamingAttempted).toBe(true)
    expect(names.read(SESSION).namingAttempted).toBe(true)
  })

  it('reads the stored name and attempted marker together', () => {
    const { names } = harness({
      conversationName: 'Fix the lease probe',
      conversationNamingAttempted: true
    })

    expect(names.read(SESSION)).toEqual({
      conversationName: 'Fix the lease probe',
      namingAttempted: true
    })
  })

  it('keeps a store failure off the caller, announces nothing, and reports it', async () => {
    const { names, onChanged, onError } = harness({}, { failWrites: true })

    await expect(names.publish(SESSION, 'Fix the lease probe')).resolves.toBeUndefined()

    expect(onChanged).not.toHaveBeenCalled()
    // Silent to the user, never silent to the log: a host whose store refuses
    // the write must not look like a model that declined to name anything.
    expect(onError).toHaveBeenCalledWith('apply-name', expect.any(Error))
  })

  it('reports a failed attempt marker rather than swallowing it', async () => {
    const { names, onError } = harness({}, { failWrites: true })

    await names.markAttempted(SESSION)

    expect(onError).toHaveBeenCalledWith('mark-attempted', expect.any(Error))
  })
})

describe('clearing marks the conversation attempted', () => {
  it('stops the next message from regenerating a name the user deleted', async () => {
    const { names, record } = harness({ conversationName: 'A name they typed' })

    await names.clear(SESSION)

    // Without this, a chat the user titled by hand and then cleared has no name
    // and no marker, so their very next message generates a replacement.
    expect(record.conversationName).toBeUndefined()
    expect(record.conversationNamingAttempted).toBe(true)
    expect(names.read(SESSION)).toEqual({ conversationName: null, namingAttempted: true })
  })

  it('still marks when the name was already absent but never asked about', async () => {
    const { names, record } = harness()

    await names.clear(SESSION)

    expect(record.conversationNamingAttempted).toBe(true)
  })

  it('does nothing once the conversation is both nameless and marked', async () => {
    const { names, applyConversationNaming } = harness({ conversationNamingAttempted: true })

    await names.clear(SESSION)

    expect(applyConversationNaming).not.toHaveBeenCalled()
  })
})

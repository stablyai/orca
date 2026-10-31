import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

import {
  fixture,
  CALLER,
  handedOver,
  journal,
  sendParams,
  submissions
} from './structured-agent-session-late-settlement-contract-test-fixture'

describe('settling a send the provider proves it received after the ack window', () => {
  it('a receipt after Stop withdrew an unwritten send keeps it cancelled', async () => {
    fixture.dispatch.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true
          })
        })
    )
    const params = sendParams('stopped before its write')
    await fixture.host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    expect(fixture.dispatch.mock.calls[0]?.[0].signal).toBeDefined()

    const stopped = await fixture.host.cancel(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fixture.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields: {}
        })
      }
    })
    expect(stopped).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([{ dispatchState: 'rejected' }])
    )
    const before = journal().cursor()
    await fixture.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
    })

    const after = journal().readSince(before)
    expect(after.ok && after.rows.filter((row) => row.kind === 'dispatch')).toEqual([])

    expect(await submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'rejected',
        rejection: { kind: 'cancelled' }
      }
    ])
  })

  it('accepts from the durable echo row when the direct settlement write fails', async () => {
    fixture.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('settle from provider echo')
    await fixture.host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    vi.spyOn(journal(), 'acceptLate').mockRejectedValueOnce(
      new Error('direct settlement write failed')
    )

    await expect(
      fixture.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'echo-row' }
      })
    ).rejects.toThrow('direct settlement write failed')
    await journal().appendItem(
      { provider: 'claude', sessionId: THREAD, uuid: 'echo-row' },
      params.body,
      {
        fence: fixture.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )

    expect(await submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'accepted',
        providerItemId: `claude:${THREAD}:echo-row`
      }
    ])
  })

  it('leaves an already accepted send alone, adding no row', async () => {
    fixture.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('ordinary send')
    await fixture.host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    const before = journal().cursor()
    const receipt = (uuid: string) =>
      fixture.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid }
      })

    await Promise.all([receipt('echo-row'), receipt('echo-row')])
    await receipt('a-different-uuid')

    const after = journal().readSince(before)
    expect(after.ok && after.rows).toHaveLength(1)
    expect(journal().submission(params.envelope.clientOperationId)).toMatchObject({
      dispatchState: 'accepted',
      providerItemId: `claude:${THREAD}:echo-row`
    })
  })

  it('ignores a session this host is not holding', async () => {
    await expect(
      fixture.host.settleLateDispatch({
        sessionId: 'session-that-is-not-attached',
        clientMessageId: 'whatever',
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'x' }
      })
    ).resolves.toBeUndefined()
  })
})

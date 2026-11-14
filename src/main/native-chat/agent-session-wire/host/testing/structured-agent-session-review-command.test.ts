import { expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'

it('carries a queued review target and accepted settings through a host restart', async () => {
  const rig = await createQueuedMessageTestRig({ restartable: true })
  const review = vi.fn<NonNullable<StructuredAgentSessionAdapter['review']>>(async () => ({
    state: 'accepted',
    providerIdentity: null
  }))
  Object.assign(rig.host.deps.adapter, { review })
  try {
    for (const [key, value] of [
      ['model', 'gpt-6.1-sol'],
      ['effort', 'high']
    ]) {
      const fields = { key: key!, value: value! }
      expect(
        await rig.host.setOption(CALLER, {
          envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
          ...fields
        })
      ).toMatchObject({ ok: true })
    }
    const working = await rig.workingSend()
    const fields = {
      command: 'review' as const,
      review: { type: 'baseBranch' as const, branch: 'release' },
      delivery: 'queue-if-active' as const
    }
    const result = await rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    expect(result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    if (!result.ok || !result.value.queued) {
      throw new Error('review was not queued')
    }
    const id = result.value.queued.messageId
    await rig.restartHostProcess()
    expect(await rig.drafts()).toContainEqual({ messageId: id, state: 'waiting' })
    await rig.settleAccepted(working, 'finished')
    await rig.resume()
    await eventually(() => expect(review).toHaveBeenCalledOnce())
    expect(review.mock.calls[0]![0]).toMatchObject({
      command: { name: 'review', review: { type: 'baseBranch', branch: 'release' } },
      executionOptions: { model: 'gpt-6.1-sol', effort: 'high' }
    })
    expect(rig.dispatch).toHaveBeenCalledOnce()
  } finally {
    await rig.dispose()
  }
})

it('cleans terminals immediately during work and deduplicates the accepted receipt', async () => {
  const rig = await createQueuedMessageTestRig()
  const cleanBackgroundTerminals = vi.fn(async () => {})
  Object.assign(rig.host.deps.adapter, { cleanBackgroundTerminals })
  try {
    await rig.workingSend()
    const fields = { scope: 'background-terminals' as const }
    const params = {
      envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
      ...fields
    }
    expect(await rig.host.cancel(CALLER, params)).toMatchObject({ ok: true })
    expect(await rig.host.cancel(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(cleanBackgroundTerminals).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: SESSION })
    )
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(await rig.drafts()).toEqual([])
  } finally {
    await rig.dispose()
  }
})

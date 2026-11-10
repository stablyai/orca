import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionOptionResult } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionMutationResult } from '../agent-session/mobile-structured-agent-session-rpc'
import {
  OPTIONS,
  deferred,
  BASE,
  accepted,
  currentValueOf,
  mountOptions,
  optionsClient,
  queuedReads,
  recordingMutate
} from './use-mobile-structured-agent-options.test-fixture'

describe('useMobileStructuredAgentOptions before the chat attaches', () => {
  it('takes a pick at once and sends it when the fence lands, locked until the chat answers', async () => {
    const client = optionsClient(queuedReads(OPTIONS))
    const reply = deferred<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    const { calls, mutate } = recordingMutate(() => reply.promise)
    const harness = await mountOptions({ ...BASE, fence: null, client: client.client, mutate })

    let taken: boolean | null = null
    await act(async () => {
      taken = await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    expect(taken).toBe(true)
    expect(calls).toEqual([])
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-fast')
    expect(harness.current().heldPick).toBe(true)

    await harness.rerender({ fence: 1 })
    expect(calls).toEqual([
      { method: 'agentSession.setOption', fields: { key: 'model', value: 'gpt-fast' } }
    ])
    expect(harness.current().heldPick).toBe(false)
    expect(harness.current().pendingOptionId).toBe('model')

    await act(async () => {
      reply.resolve(
        accepted({ key: 'model', value: 'gpt-fast', options: { model: 'gpt-fast' } }, true)
      )
    })
    expect(harness.current().pendingOptionId).toBeNull()
    await harness.unmount()
  })

  it('falls back to the chat model with a notice when the chat refuses the held pick', async () => {
    const client = optionsClient(queuedReads(OPTIONS))
    const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
    const onOptionError = vi.fn()
    const harness = await mountOptions({
      ...BASE,
      fence: null,
      client: client.client,
      mutate,
      onOptionError
    })
    await act(async () => {
      await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    expect(onOptionError).not.toHaveBeenCalled()

    await harness.rerender({ fence: 1 })
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-live')
    expect(onOptionError).toHaveBeenCalledOnce()
    await harness.unmount()
  })
})

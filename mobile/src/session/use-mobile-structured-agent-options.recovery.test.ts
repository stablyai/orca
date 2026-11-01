import { act } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import {
  BASE,
  OPTIONS,
  accepted,
  descriptorFor,
  mountOptions,
  optionsClient,
  recordingMutate,
  settle
} from './use-mobile-structured-agent-options.test-fixture'

it('keeps known phone pickers writable after a restarted process options read fails', async () => {
  const failed = Promise.withResolvers<AgentSessionOptionsResult>()
  let reads = 0
  const rpc = optionsClient(() =>
    ++reads === 1
      ? Promise.resolve({ ...OPTIONS, current: { ...OPTIONS.current, permissionMode: 'ask' } })
      : failed.promise
  )
  const { calls, mutate } = recordingMutate(async () =>
    accepted({ key: 'model', value: 'gpt-fast', options: { model: 'gpt-fast' } }, true)
  )
  const view = await mountOptions({ ...BASE, client: rpc.client, mutate, coherentCatalog: true })
  try {
    const beforeRestart = reads
    await view.rerender({ fence: 2 })
    await act(async () => {
      failed.reject(new Error('host timeout'))
      await settle()
    })
    await vi.waitFor(() => expect(reads).toBe(beforeRestart + 3))
    for (const id of ['model', 'effort', 'permissionMode']) {
      expect(descriptorFor(view.current().optionSnapshot, id)?.settable).toBe(true)
    }
    let applied = false
    await act(async () => {
      applied = await view.current().setStructuredOption('model', 'gpt-fast')
    })
    expect(applied).toBe(true)
    expect(calls).toHaveLength(1)
  } finally {
    await view.unmount()
  }
})

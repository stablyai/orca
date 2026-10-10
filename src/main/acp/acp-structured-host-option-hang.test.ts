// A model or effort pick Grok never answers, through the real host: it must not hold the chat's
// Stop or Close behind it, and on its own it fails at a bound instead of holding the chat forever.

import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { GROK_CONFIG_OPTIONS, waitFor } from './acp-structured-adapter.test-support'
import { framesOf, openAttachedHostRig, stop } from './acp-structured-host.test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

function pick(host: StructuredAgentSessionHost, value: string) {
  const fields = { key: 'model', value }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

/** Whether `promise` settled within `ms`, and how. */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ settled: 'resolved' as const, value }),
        (error: unknown) => ({ settled: 'rejected' as const, value: error })
      ),
      late
    ])
  } finally {
    clearTimeout(timer)
  }
}

const failed = (outcome: Awaited<ReturnType<typeof within>>) =>
  outcome !== 'pending' &&
  (outcome.settled === 'rejected' ||
    (typeof outcome.value === 'object' && outcome.value !== null && 'ok' in outcome.value
      ? outcome.value.ok === false
      : false))

describe('a Grok model pick Grok never answers', () => {
  it('does not hold a Stop behind it; the pick fails', async () => {
    const { rig, host } = await openAttachedHostRig()
    const picking = pick(host, 'grok-4.6')
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(1))
    expect(await within(stop(host), 2_000)).toMatchObject({ settled: 'resolved' })
    expect(failed(await within(picking, 1_000))).toBe(true)
    expect(await within(host.close(SESSION, 'user-close'), 2_000)).not.toBe('pending')
  })

  it('does not hold a Close behind it; the pick fails', async () => {
    const { rig, host } = await openAttachedHostRig()
    const picking = pick(host, 'grok-4.6')
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(1))
    expect(await within(host.close(SESSION, 'user-close'), 2_000)).toMatchObject({
      settled: 'resolved'
    })
    expect(failed(await within(picking, 1_000))).toBe(true)
  })

  it('fails at its bound, frees the chat, and keeps what Grok answers late', async () => {
    const { rig, host } = await openAttachedHostRig({ optionWriteTimeoutMs: 100 })
    const picking = pick(host, 'grok-4.6')
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(1))
    expect(failed(await within(picking, 2_000))).toBe(true)
    // The chat's queue moved on: a later operation runs.
    expect(await within(host.readOptions(SESSION), 1_000)).not.toBe('pending')
    const [frame] = framesOf(rig.child(), 'session/set_config_option')
    rig.child().agent.reply(frame!, {
      configOptions: GROK_CONFIG_OPTIONS.map((option) =>
        option.id === 'model' ? { ...option, currentValue: 'grok-4.6' } : option
      )
    })
    await waitFor(async () =>
      expect((await host.readOptions(SESSION)).current).toMatchObject({ model: 'grok-4.6' })
    )
    await host.close(SESSION, 'user-close')
  })
})

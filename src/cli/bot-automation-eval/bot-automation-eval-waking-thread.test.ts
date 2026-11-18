import { describe, expect, it } from 'vitest'
import { EVAL_BOT, type EvalHostState } from './bot-automation-eval-host'
import { serveWakingThread, wakingThreadRef } from './bot-automation-eval-waking-thread'

const state = (over: Partial<EvalHostState> = {}): EvalHostState => ({
  bots: [{ ...EVAL_BOT, agent: 'claude' }],
  automations: [],
  repos: [],
  timezone: 'UTC',
  conversation: { source: 'slack', title: 'x', slack: { channel: 'C1', thread: '1.0' } },
  ...over
})

describe('the waking Slack thread', () => {
  it('takes a bot reply file as an attachment there', () => {
    const recorded: Record<string, unknown>[] = []
    const io = { record: (entry: Record<string, unknown>) => recorded.push(entry), save: () => {} }
    expect(serveWakingThread(state(), 'reply', undefined, { args: {} }, io)).toMatchObject({
      ok: true
    })
    expect(recorded).toEqual([
      expect.objectContaining({
        method: 'connector.attach',
        result: { target: 'slack:T0EVAL:C1:1.0' }
      })
    ])
  })

  it('refuses a slack post into it, but not into the channel or another thread', () => {
    const io = { record: () => {}, save: () => {} }
    const post = (ref: string) => serveWakingThread(state(), 'post', ref, {}, io)
    expect(post('slack:T0EVAL:C1:1.0')).toMatchObject({ refusal: 'use_reply' })
    expect(post('slack:T0EVAL:C1')).toBeUndefined()
    expect(post('slack:T0EVAL:C1:2.0')).toBeUndefined()
  })

  it('is none outside a Slack conversation', () => {
    expect(wakingThreadRef(state({ conversation: undefined }))).toBeNull()
  })
})

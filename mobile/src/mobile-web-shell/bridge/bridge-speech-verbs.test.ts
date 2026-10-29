import { describe, expect, it } from 'vitest'
import { ID, harness } from '../bridge-host-test-harness'
import { clientFrame, flushBridge } from '../bridge-host-test-fakes'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'
import { SPEECH_MAX_MARKDOWN_CHARS } from './bridge-speech-verbs'

const VERB = 'native.speech.control'

function speakRequest(params: unknown): string {
  return clientFrame({ type: 'request', id: ID, method: VERB, params })
}

function speechHarness(routeGrants?: readonly string[]) {
  return harness({
    ready: true,
    ...(routeGrants === undefined ? {} : { routeGrants }),
    serveNativeVerb: () => Promise.resolve({ accepted: true })
  })
}

describe('a page asking the shell to read a reply aloud', () => {
  it('is spoken by the shell and never forwarded to the desktop', async () => {
    const bridge = speechHarness()
    const params = { action: 'speak', id: 'reply-1', markdown: '**Done.**' }
    bridge.host.receive(speakRequest(params))
    await flushBridge()
    expect(bridge.nativeCalls).toEqual([{ verb: VERB, params }])
    expect(bridge.client.requests).toEqual([])
    const reply = bridge.last()
    expect(reply.type === 'reply' && 'payload' in reply ? reply.payload : null).toEqual({
      id: ID,
      ok: true,
      result: { accepted: true }
    })
  })

  it('is refused on a route that did not ask for the verb', async () => {
    const bridge = speechHarness(['navigate', 'storage'])
    bridge.host.receive(speakRequest({ action: 'speak', id: 'reply-1', markdown: 'Done.' }))
    await flushBridge()
    const refusal = bridge.last()
    expect(refusal.type === 'error' && refusal.error.code).toBe('native_verb_ungranted')
    expect(bridge.nativeCalls).toEqual([])
  })

  it('refuses params the verb does not take before any handler runs', async () => {
    const bridge = speechHarness()
    for (const params of [
      { action: 'stop' },
      { action: 'speak', id: '', markdown: 'Done.' },
      { action: 'speak', id: 'reply-1', markdown: '' },
      { action: 'speak', id: 'reply-1', markdown: 'a'.repeat(SPEECH_MAX_MARKDOWN_CHARS + 1) },
      { action: 'speak', id: 'reply-1', markdown: 'Done.', voice: 'x' }
    ]) {
      bridge.host.receive(speakRequest(params))
      await flushBridge()
      const refusal = bridge.last()
      expect(refusal.type === 'error' && refusal.error.code).toBe('native_verb_params')
    }
    expect(bridge.nativeCalls).toEqual([])
  })

  it('fits the longest reply in one frame even when JSON escapes every character', () => {
    const frame = speakRequest({
      action: 'speak',
      id: '\u0001'.repeat(512),
      markdown: '\u0001'.repeat(SPEECH_MAX_MARKDOWN_CHARS)
    })
    expect(new TextEncoder().encode(frame).length).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
  })
})

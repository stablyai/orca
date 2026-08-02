import { describe, expect, it } from 'vitest'
import {
  nativeChatTextDigest,
  NativeChatTextRetrievalCapabilities
} from './text-retrieval-capabilities'

describe('NativeChatTextRetrievalCapabilities', () => {
  it('issues opaque grants scoped to one owner and exact block digest', () => {
    const capabilities = new NativeChatTextRetrievalCapabilities()
    const text = 'complete response'
    const capability = capabilities.issue(
      {
        owner: 'paired:device-1',
        agent: 'claude',
        sessionId: 'session-1',
        transcriptPath: '/trusted/session.jsonl',
        messageId: 'message-1',
        recordOffset: 42,
        blockIndex: 1,
        originalChars: text.length,
        text
      },
      100
    )

    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(capabilities.redeem(capability, 'paired:device-2', 101)).toBeNull()
    expect(capabilities.redeem(capability, 'paired:device-1', 101)).toMatchObject({
      transcriptPath: '/trusted/session.jsonl',
      messageId: 'message-1',
      recordOffset: 42,
      blockIndex: 1,
      digest: nativeChatTextDigest(text)
    })
  })

  it('expires grants without retaining redeemable authority', () => {
    const capabilities = new NativeChatTextRetrievalCapabilities()
    const capability = capabilities.issue(
      {
        owner: 'local',
        agent: 'codex',
        sessionId: 'session-1',
        messageId: 'message-1',
        recordOffset: 0,
        blockIndex: 0,
        originalChars: 4,
        text: 'text'
      },
      0
    )

    expect(capabilities.redeem(capability, 'local', 2 * 60 * 60 * 1000)).toBeNull()
  })
})

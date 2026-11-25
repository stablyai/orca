import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_ADVISOR_PRESENTATION } from '../../../shared/native-chat/transcript/notices/native-chat-notice'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

describe('decodeOmpTranscriptLine', () => {
  it('decodes an advisor card as an advisor aside from its notes', () => {
    const line = JSON.stringify({
      type: 'custom_message',
      id: 'a1',
      customType: 'advisor',
      display: true,
      content: '<advisory>check callers</advisory>',
      details: { notes: [{ advisor: 'Reviewer', severity: 'concern', note: 'check callers' }] }
    })
    expect(decodeOmpTranscriptLine(line, 'fallback')?.blocks).toEqual([
      {
        type: 'text',
        text: 'Reviewer (concern): check callers',
        presentation: NATIVE_CHAT_ADVISOR_PRESENTATION
      }
    ])
  })
})

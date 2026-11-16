import advisorCapture from '../../../shared/__fixtures__/claude-server-tools-2.1.318.json'
import { expect, it } from 'vitest'
import { transcriptMessagesFromDecodedMessage } from './session-transcript-message-content'
import { decodeSessionMessage } from './session-decoded-message'

const AT = '2026-05-01T10:00:00.000Z'

it('keeps captured server calls and structured results in full Session History', () => {
  const messages = advisorCapture.flatMap((frame) =>
    transcriptMessagesFromDecodedMessage(
      decodeSessionMessage('assistant', frame.message.content, AT)
    )
  )
  expect(messages).toEqual([
    { role: 'tool', text: 'advisor', timestamp: AT },
    {
      role: 'tool',
      text: '{"type":"advisor_redacted_result","encrypted_content":"redacted-advisor-content"}',
      timestamp: AT
    }
  ])
})

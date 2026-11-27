import { expect, it } from 'vitest'
import { decodeSessionMessage } from './session-decoded-message'
import { transcriptMessagesFromDecodedMessage } from './session-transcript-message-content'

it('keeps ordered text runs around tools only when the source requests block order', () => {
  const decoded = decodeSessionMessage(
    'assistant',
    [
      { type: 'reasoning', text: 'Checking the compiler.' },
      { type: 'text', text: 'Running the build.' },
      { type: 'tool_use', name: 'bash', input: { command: 'npm test' } },
      { type: 'tool_result', content: 'Missing package' },
      { type: 'text', text: 'The dependency is missing.' },
      { type: 'text', text: 'Install it.' }
    ],
    '2026-07-15T10:00:00.001Z'
  )
  const timestamp = '2026-07-15T10:00:00.001Z'
  expect(transcriptMessagesFromDecodedMessage(decoded)).toEqual([
    {
      role: 'assistant',
      text: 'Checking the compiler.\nRunning the build.\nThe dependency is missing.\nInstall it.',
      timestamp
    },
    { role: 'tool', text: 'bash: npm test', timestamp },
    { role: 'tool', text: 'Missing package', timestamp }
  ])
  expect(transcriptMessagesFromDecodedMessage(decoded, { preserveBlockOrder: true })).toEqual([
    { role: 'assistant', text: 'Checking the compiler.\nRunning the build.', timestamp },
    { role: 'tool', text: 'bash: npm test', timestamp },
    { role: 'tool', text: 'Missing package', timestamp },
    { role: 'assistant', text: 'The dependency is missing.\nInstall it.', timestamp }
  ])
})

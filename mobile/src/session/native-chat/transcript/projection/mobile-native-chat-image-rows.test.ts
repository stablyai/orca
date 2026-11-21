import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { finishMobileNativeChatMessages } from './mobile-native-chat-render-data'

const user = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript'
})

describe('a pasted photo in the transcript', () => {
  it('folds the image-source row into its prompt so the photo and its caption stay one message', () => {
    const rows = finishMobileNativeChatMessages([
      user('prompt', '[Image #1] what is this'),
      user('source', '[Image: source: /var/folders/x/T/orca-paste-1.jpg]')
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/var/folders/x/T/orca-paste-1.jpg' },
      { type: 'text', text: 'what is this' }
    ])
  })
})

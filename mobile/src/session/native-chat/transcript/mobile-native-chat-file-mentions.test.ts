import { describe, expect, it } from 'vitest'
import { formatNativeChatFileReference } from '../../../../../src/shared/agent-image-paste'
import { splitUserFileMentions } from './mobile-native-chat-file-mentions'

const text = (value: string) => ({ type: 'text' as const, text: value })

describe('splitUserFileMentions', () => {
  it('turns shared-document mention lines into tiles and keeps the rest of the message', () => {
    const shared = [
      'Read this and tell me whether we should cite it',
      formatNativeChatFileReference('docs/paper.pdf'),
      formatNativeChatFileReference('docs/my notes (2).md'),
      formatNativeChatFileReference('docs/config.properties')
    ].join('\n')

    expect(splitUserFileMentions([text(shared)])).toEqual({
      paths: ['docs/paper.pdf', 'docs/my notes (2).md', 'docs/config.properties'],
      blocks: [text('Read this and tell me whether we should cite it')]
    })
  })

  it('drops a block that was only mentions', () => {
    expect(splitUserFileMentions([text('@docs/paper.pdf')])).toEqual({
      paths: ['docs/paper.pdf'],
      blocks: []
    })
  })

  it('leaves mentions inside a sentence and non-file mentions as text', () => {
    const blocks = [text('see @docs/paper.pdf first'), text('@someone'), text('@docs/')]
    expect(splitUserFileMentions(blocks)).toEqual({ paths: [], blocks })
  })
})

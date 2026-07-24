import { describe, expect, it } from 'vitest'
import { decodeGrokTranscriptLine } from './transcript-line-decoders'

describe('decodeGrokTranscriptLine', () => {
  it('decodes user text and strips <user_query> wrappers', () => {
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\nFix the bug\n</user_query>' }],
      timestamp: '2026-06-18T00:00:00.000Z'
    })
    expect(decodeGrokTranscriptLine(line, 'fb-1')).toEqual({
      id: 'fb-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix the bug' }],
      timestamp: Date.parse('2026-06-18T00:00:00.000Z'),
      source: 'transcript'
    })
  })

  it('decodes assistant tool calls on empty content rows', () => {
    const line = JSON.stringify({
      type: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'grep', arguments: '{"pattern":"foo"}' }],
      id: 'asst-1'
    })
    expect(decodeGrokTranscriptLine(line, 'fb-2')).toEqual({
      id: 'fb-2:asst-1',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'grep', input: { pattern: 'foo' } }],
      timestamp: null,
      source: 'transcript'
    })
  })

  it.each([
    'C:\\Users\\me\\AppData\\Local\\Temp\\orca-paste-1783675302563-2207c073-535f-4b83-a181-61127c8bbd68.png',
    '/tmp/orca-paste-1783675302563-2207c073-535f-4b83-a181-61127c8bbd68.png',
    'C:\\orca-paste-1783675302563-2207c073-535f-4b83-a181-61127c8bbd68.png',
    '/orca-paste-1783675302563-2207c073-535f-4b83-a181-61127c8bbd68.png',
    '\\\\server\\temp\\orca-paste-1783675302563-2207c073-535f-4b83-a181-61127c8bbd68.png'
  ])('restores a pasted image and prompt from Grok transcript text for %s', (imagePath) => {
    const line = JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'text',
          text: `<user_query>\n${imagePath}Describe this image\n</user_query>`
        }
      ]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-image')).toMatchObject({
      role: 'user',
      blocks: [
        { type: 'image-ref', path: imagePath },
        { type: 'text', text: 'Describe this image' }
      ]
    })
  })

  it('restores a mobile Files-picker image upload (orca-file-… name) as an image-ref', () => {
    const imagePath = '/tmp/orca-file-1784234906335-f54c579b-819c-4c33-8bd1-2d34ebf871ab-photo.jpg'
    const line = JSON.stringify({
      type: 'user',
      content: [
        { type: 'text', text: `<user_query>\n${imagePath}Describe this image\n</user_query>` }
      ]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-mobile-image')).toMatchObject({
      role: 'user',
      blocks: [
        { type: 'image-ref', path: imagePath },
        { type: 'text', text: 'Describe this image' }
      ]
    })
  })

  it('resolves multi-dot mobile upload names to their last image extension', () => {
    const imagePath =
      '/tmp/orca-file-1784234906335-f54c579b-819c-4c33-8bd1-2d34ebf871ab-photo.jpg.backup.png'
    const line = JSON.stringify({
      type: 'user',
      content: [
        { type: 'text', text: `<user_query>\n${imagePath}Describe this image\n</user_query>` }
      ]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-multidot')).toMatchObject({
      role: 'user',
      blocks: [
        { type: 'image-ref', path: imagePath },
        { type: 'text', text: 'Describe this image' }
      ]
    })
  })

  it('leaves non-image mobile uploads (orca-file-… .pdf) as plain text', () => {
    const text =
      '/tmp/orca-file-1784234906335-f54c579b-819c-4c33-8bd1-2d34ebf871ab-report.pdf summarize this'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${text}</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-mobile-pdf')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
  })

  it('rejects the ambiguous interior-image-extension split instead of truncating the path', () => {
    // A non-image file (`photo.jpg.tmp`) whose interior contains an image
    // extension must stay plain text, not become image-ref + garbled prompt.
    const text =
      '/tmp/orca-file-1784234906335-f54c579b-819c-4c33-8bd1-2d34ebf871ab-photo.jpg.tmp summarize'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${text}</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-ambiguous-split')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
  })

  it('rejects an attachment-only ambiguous name the same way', () => {
    const text = '/tmp/orca-file-1784234906335-f54c579b-819c-4c33-8bd1-2d34ebf871ab-photo.jpg.tmp'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${text}</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-ambiguous-only')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
  })

  it('still splits prompt punctuation that cannot extend a filename', () => {
    const imagePath = '/tmp/orca-file-1784234906335-f54c579b-819c-4c33-8bd1-2d34ebf871ab-photo.jpg'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${imagePath}. What is this?</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-punctuation')).toMatchObject({
      role: 'user',
      blocks: [
        { type: 'image-ref', path: imagePath },
        { type: 'text', text: '. What is this?' }
      ]
    })
  })

  it('never converts names without the structural ts-uuid prefix', () => {
    const text = '/tmp/orca-file-mynotes.png explain'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${text}</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-no-structure')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
  })

  it('restores an attachment-only pasted image from Grok transcript text', () => {
    const imagePath = '/tmp/orca-paste-1783675302563-2207c073-535f-4b83-a181-61127c8bbd68.png'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${imagePath}</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-image-only')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'image-ref', path: imagePath }]
    })
  })

  it('preserves ordinary prompts that mention pasted-image filenames', () => {
    const text = 'Explain what an orca-paste-123-example.png file is'
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>${text}</user_query>` }]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-image-mention')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
  })

  it('preserves assistant text containing a literal user_query tag', () => {
    const text = 'Before <user_query>quoted example</user_query> after'
    const line = JSON.stringify({ type: 'assistant', content: text })

    expect(decodeGrokTranscriptLine(line, 'fb-assistant-tag')).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text }]
    })
  })

  it.each(['project_instructions', 'system_reminder'])(
    'skips Grok synthetic user rows with reason %s',
    (syntheticReason) => {
      const line = JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: 'Internal context' }],
        synthetic_reason: syntheticReason
      })

      expect(decodeGrokTranscriptLine(line, `fb-${syntheticReason}`)).toBeNull()
    }
  )

  it.each([
    '<user_info>bootstrap context</user_info>',
    [{ type: 'text', text: '<USER_INFO>bootstrap context</USER_INFO>' }],
    [
      {
        type: 'text',
        text: [
          '<user_info>Runtime context</user_info>',
          '<git_status>Working tree snapshot</git_status>'
        ].join('\n\n')
      }
    ]
  ])('skips a standalone Grok user_info bootstrap row', (content) => {
    expect(
      decodeGrokTranscriptLine(JSON.stringify({ type: 'user', content }), 'fb-user-info')
    ).toBeNull()
  })

  it('keeps a real query that discusses the user_info tag', () => {
    const line = JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'text',
          text: '<user_query>Explain the <user_info> tag</user_query>'
        }
      ]
    })

    expect(decodeGrokTranscriptLine(line, 'fb-user-info-query')).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'Explain the <user_info> tag' }]
    })
  })

  it('filters Grok bootstrap rows from a real-schema transcript prefix', () => {
    const rows = [
      { type: 'system', content: 'System context' },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_info>Runtime context</user_info>' }]
      },
      {
        type: 'user',
        content: [{ type: 'text', text: 'Project context' }],
        synthetic_reason: 'project_instructions'
      },
      {
        type: 'user',
        content: [{ type: 'text', text: 'Reminder context' }],
        synthetic_reason: 'system_reminder'
      },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>Visible prompt</user_query>' }]
      },
      { type: 'assistant', content: 'Visible answer' }
    ]

    const messages = rows
      .map((row, index) => decodeGrokTranscriptLine(JSON.stringify(row), `fb-real-schema-${index}`))
      .filter((message) => message !== null)

    expect(messages).toMatchObject([
      { role: 'user', blocks: [{ type: 'text', text: 'Visible prompt' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'Visible answer' }] }
    ])
  })

  it('decodes reasoning summaries', () => {
    const line = JSON.stringify({
      type: 'reasoning',
      id: 'rs-1',
      summary: [{ type: 'summary_text', text: 'Planning the change' }]
    })
    expect(decodeGrokTranscriptLine(line, 'fb-3')).toMatchObject({
      id: 'fb-3:rs-1',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Planning the change' }],
      source: 'transcript'
    })
  })

  it('skips system prompts', () => {
    const line = JSON.stringify({ type: 'system', content: 'You are Grok' })
    expect(decodeGrokTranscriptLine(line, 'fb-4')).toBeNull()
  })
})

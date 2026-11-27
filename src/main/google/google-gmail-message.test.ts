import { expect, it } from 'vitest'
import { bodyText, type Part } from './google-gmail-message'

const textPart = (mimeType: string, text: string): Part => ({
  mimeType,
  body: { data: Buffer.from(text).toString('base64url') }
})

it('keeps mixed body sections while selecting each nested alternative and excluding attachments', () => {
  const message: Part = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          textPart('text/plain', 'First section'),
          {
            mimeType: 'multipart/related',
            parts: [textPart('text/html', '<p>Alternate first section</p>')]
          }
        ]
      },
      {
        mimeType: 'multipart/alternative',
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [textPart('text/html', '<p>Second section</p>')]
          }
        ]
      },
      { ...textPart('text/plain', 'Attached note'), filename: 'note.txt' }
    ]
  }
  expect(bodyText(message)).toBe('First section\nSecond section')
})

it('does not let related CID resources replace the preferred plain body', () => {
  const root: Part = {
    ...textPart('text/html', '<p>HTML body</p>'),
    headers: [{ name: 'Content-ID', value: '<body>' }]
  }
  const resource: Part = {
    ...textPart('text/plain', 'Inline resource'),
    headers: [{ name: 'Content-ID', value: '<details>' }]
  }
  const related: Part = { mimeType: 'multipart/related', parts: [root, resource] }
  expect(
    bodyText({
      mimeType: 'multipart/alternative',
      parts: [textPart('text/plain', 'Complete plain body'), related]
    })
  ).toBe('Complete plain body')
  expect(
    bodyText({
      ...related,
      headers: [{ name: 'Content-Type', value: 'multipart/related; start="<body>"' }],
      parts: [resource, root]
    })
  ).toBe('HTML body')
})

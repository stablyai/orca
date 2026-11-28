import { expect, it } from 'vitest'
import { appendRequests, markdownToDocText } from './google-docs-markdown'

it('keeps shorter and mismatched fences literal inside a Docs code block', () => {
  const markdown = '````markdown\n```js\n**literal**\n```\n````\n# After'
  const converted = markdownToDocText(markdown)
  expect(converted.text).toBe('```js\n**literal**\n```\nAfter')
  expect(converted.spans).toEqual([
    { start: 0, end: 5, code: true },
    { start: 6, end: 17, code: true },
    { start: 18, end: 21, code: true }
  ])
  expect(converted.paragraphs.at(-1)).toEqual({ start: 22, end: 27, heading: 1 })
  expect(appendRequests(markdown, 1, false)[0]).toEqual({
    insertText: { location: { index: 1 }, text: converted.text }
  })
  expect(markdownToDocText('~~~\n```\n**literal**\n~~~\nAfter').text).toBe(
    '```\n**literal**\nAfter'
  )
  const mixed = markdownToDocText('~~~\n~~~```\n**literal**\n~~~\n# After')
  expect(mixed.text).toBe('~~~```\n**literal**\nAfter')
  expect(mixed.spans).toEqual([
    { start: 0, end: 6, code: true },
    { start: 7, end: 18, code: true }
  ])
  expect(mixed.paragraphs.at(-1)).toEqual({ start: 19, end: 24, heading: 1 })
  const tab = markdownToDocText('```\nx\n```\t\n# After')
  expect(tab.text).toBe('x\nAfter')
  expect(tab.spans).toEqual([{ start: 0, end: 1, code: true }])
  expect(tab.paragraphs.at(-1)).toEqual({ start: 2, end: 7, heading: 1 })
})

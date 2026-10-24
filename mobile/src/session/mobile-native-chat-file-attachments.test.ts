import { expect, it } from 'vitest'
import { formatNativeChatFileReference } from '../../../src/shared/agent-image-paste'
import { splitMobileNativeChatFileAttachments } from './mobile-native-chat-file-attachments'

it.each([
  '/root/.orca/agent-session-attachments/id/report.pdf',
  '/Users/me/.orca/agent-session-attachments/id/Quarterly report.pdf',
  String.raw`C:\Orca\agent-session-attachments\id\report.pdf`,
  '/root/.orca/agent-session-attachments/id/both\'and" quotes.txt'
])('extracts the existing desktop file reference without changing its path: %s', (path) => {
  expect(
    splitMobileNativeChatFileAttachments([
      { type: 'text', text: `${formatNativeChatFileReference(path)}\nPlease review.` }
    ])
  ).toEqual({ files: [path], prose: [{ type: 'text', text: '\nPlease review.' }] })
})

it('leaves workspace mentions, links, quoted references and fenced code as ordinary text', () => {
  const text =
    '@src/app.ts @someone `@/root/agent-session-attachments/id/a.pdf`\n```\n@/root/agent-session-attachments/id/b.pdf\n```'
  const block = { type: 'text' as const, text }
  expect(splitMobileNativeChatFileAttachments([block])).toEqual({ files: [], prose: [block] })
})

it('omits an empty file-only text bubble and deduplicates the same attached path', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  expect(
    splitMobileNativeChatFileAttachments([{ type: 'text', text: `@${path}\n@${path}` }])
  ).toEqual({ files: [path], prose: [] })
})

it('removes the attachment separator without changing other multiline spacing', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  expect(
    splitMobileNativeChatFileAttachments([
      { type: 'text', text: `Please @${path} review.\n    Keep  indentation.\n\tKeep  tabs.` }
    ])
  ).toEqual({
    files: [path],
    prose: [{ type: 'text', text: 'Please review.\n    Keep  indentation.\n\tKeep  tabs.' }]
  })
})

it('keeps a line break that precedes an attachment reference', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  expect(
    splitMobileNativeChatFileAttachments([
      { type: 'text', text: `First line\n@${path} next line.` }
    ]).prose
  ).toEqual([{ type: 'text', text: 'First line\n next line.' }])
})

it.each(['```', '~~~', '````'])(
  'extracts references outside a %s fence while preserving fenced examples',
  (fence) => {
    const path = '/root/.orca/agent-session-attachments/id/report.pdf'
    const example = '/root/.orca/agent-session-attachments/id/example.pdf'
    const text = `@${path}\n${fence}text\n@${example}\n${fence}\nReview.`
    expect(splitMobileNativeChatFileAttachments([{ type: 'text', text }])).toEqual({
      files: [path],
      prose: [{ type: 'text', text: `\n${fence}text\n@${example}\n${fence}\nReview.` }]
    })
  }
)

it('preserves leading indentation and trailing whitespace after removing a file reference', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  expect(
    splitMobileNativeChatFileAttachments([{ type: 'text', text: `    code\n@${path}\n` }])
  ).toEqual({ files: [path], prose: [{ type: 'text', text: '    code\n\n' }] })
})

it.each(['` @PATH `', '`` a ` @PATH ``', '`\n@PATH\n`'])(
  'keeps inline code literal while extracting a reference from prose: %s',
  (literal) => {
    const path = '/root/.orca/agent-session-attachments/id/report.pdf'
    const code = literal.replace('@PATH', `@${path}`)
    const text = `Review ${code} and @${path} please.`
    expect(splitMobileNativeChatFileAttachments([{ type: 'text', text }])).toEqual({
      files: [path],
      prose: [{ type: 'text', text: `Review ${code} and please.` }]
    })
  }
)
it('does not turn an unmatched backtick into an inline code span', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  expect(
    splitMobileNativeChatFileAttachments([{ type: 'text', text: `Review \` @${path} please.` }])
  ).toEqual({
    files: [path],
    prose: [{ type: 'text', text: 'Review ` please.' }]
  })
})

it('does not extract a file tile from a code-only reference', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  const block = { type: 'text' as const, text: `Review \` @${path} \`.` }
  expect(splitMobileNativeChatFileAttachments([block])).toEqual({ files: [], prose: [block] })
})
it('does not pair backticks across separate Markdown paragraphs', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  const text = `Before \`\n\n@${path}\n\n\` after`
  expect(splitMobileNativeChatFileAttachments([{ type: 'text', text }])).toEqual({
    files: [path],
    prose: [{ type: 'text', text: 'Before `\n\n\n\n` after' }]
  })
})

it('does not pair an HTML attribute backtick with a real inline code delimiter', () => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  const code = `<span title="\`"> \` @${path} \``
  expect(splitMobileNativeChatFileAttachments([{ type: 'text', text: code }])).toEqual({
    files: [],
    prose: [{ type: 'text', text: code }]
  })
})

it.each([
  '<span title="@PATH">label</span>',
  '[Open @PATH](https://example.com)',
  '| Reference |\n| --- |\n| ` @PATH ` |'
])('preserves attachment-looking text within Markdown markup: %s', (markup) => {
  const path = '/root/.orca/agent-session-attachments/id/report.pdf'
  const text = markup.replace('@PATH', `@${path}`)
  expect(splitMobileNativeChatFileAttachments([{ type: 'text', text }])).toEqual({
    files: [],
    prose: [{ type: 'text', text }]
  })
})

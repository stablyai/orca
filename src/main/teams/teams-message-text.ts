// A Teams message's words both ways: Graph's HTML body read as plain text (mentions as @Name), and
// text a bot posts turned into HTML that shows exactly what it typed.
import { htmlToText } from '../google/google-html-text'

type GraphBody = { contentType?: string | null; content?: string | null }
type GraphAttachment = { contentType?: string | null; name?: string | null }

export function teamsMessageText(
  body: GraphBody | null | undefined,
  attachments: GraphAttachment[] = []
): string {
  const content = body?.content ?? ''
  const text =
    body?.contentType === 'html'
      ? htmlToText(
          content
            .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_tag, name: string) => `@${name}`)
            .replace(/<attachment\b[^>]*>\s*<\/attachment>/gi, '')
        )
      : content.trim()
  // A quoted reply is a messageReference; its words are already in the message it quotes.
  const files = attachments
    .filter((attachment) => attachment.contentType !== 'messageReference' && attachment.name)
    .map((attachment) => `[file: ${attachment.name}]`)
  return [text, ...files].filter(Boolean).join('\n')
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

/** Plain text as Teams HTML: every markup character escaped, line breaks and indents kept. */
export function teamsPostHtml(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)
      // HTML folds runs of spaces; single spaces between words stay plain so lines still wrap.
      .replace(/^ +| {2,}/gm, (spaces) => '&nbsp;'.repeat(spaces.length))
      .replace(/\n/g, '<br>')
  )
}

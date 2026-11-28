import { decodeHtmlEntities } from '../../shared/text/html-entities'

// An HTML email or file as plain text: block ends become line breaks, tags go, entities are decoded.
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      // A plain space, not U+00A0, so the line-end trim below strips it.
      .replace(/&nbsp;/gi, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

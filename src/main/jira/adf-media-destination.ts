// encodeURI leaves parentheses that can terminate Markdown image destinations.

const MARKDOWN_DESTINATION_HOSTILE = new Set(['(', ')', '[', ']', '<', '>', '"', "'", '`', '\\'])

function isMarkdownDestinationHostile(char: string): boolean {
  if (MARKDOWN_DESTINATION_HOSTILE.has(char)) {
    return true
  }
  const code = char.charCodeAt(0)
  return code <= 0x20
}

function percentEncodeUtf8Char(char: string): string {
  return Array.from(
    new TextEncoder().encode(char),
    (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('')
}

/** Percent-encode markdown-hostile destination chars without double-encoding `%HH`. */
function encodeMarkdownDestination(url: string): string | null {
  let encoded = ''
  for (let i = 0; i < url.length;) {
    const char = url[i] ?? ''
    if (char === '%') {
      const hex = url.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        encoded += `%${hex}`
        i += 3
        continue
      }
      encoded += '%25'
      i += 1
      continue
    }
    if (isMarkdownDestinationHostile(char)) {
      encoded += percentEncodeUtf8Char(char)
      i += 1
      continue
    }
    encoded += char
    i += 1
  }

  for (const char of encoded) {
    if (isMarkdownDestinationHostile(char)) {
      return null
    }
  }
  return encoded
}

export function escapeMarkdownLinkDestination(url: string): string | null {
  return /^https?:\/\//i.test(url) ? encodeMarkdownDestination(url) : null
}

export function escapeMarkdownTextLinkDestination(url: string): string | null {
  return /^(?:https?:\/\/|mailto:)/i.test(url) ? encodeMarkdownDestination(url) : null
}

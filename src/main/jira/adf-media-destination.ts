// Why: markdown image destinations close at the first unescaped `)`. encodeURI
// leaves `()` alone, so Jira-controlled external URLs must be destination-safe.

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
export function escapeMarkdownLinkDestination(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) {
    return null
  }

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

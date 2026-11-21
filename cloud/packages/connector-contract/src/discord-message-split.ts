// A bot's answer as Discord messages: Discord takes at most 2,000 characters in one, so a longer
// answer posts as several, in order, each split where a reader would pause.

export const DISCORD_MESSAGE_MAX_LENGTH = 2000

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/

type Fence = { marker: string; opener: string }

// The code block still open at the end of `text`, if any.
function openFence(text: string): Fence | null {
  let open: Fence | null = null
  for (const line of text.split('\n')) {
    if (open === null) {
      const marker = FENCE_OPEN.exec(line)?.[1]
      if (marker) {
        open = { marker, opener: line.trimEnd() }
      }
      continue
    }
    const end = FENCE_CLOSE.exec(line)?.[1]
    if (end && end[0] === open.marker[0] && end.length >= open.marker.length) {
      open = null
    }
  }
  return open
}

// Where to end a part of `text` no longer than `limit`: after a paragraph, else a line, else a
// word, as long as that keeps at least half the room; else at `limit`, never inside a surrogate
// pair. Answers [end of this part, start of the next].
function breakAt(text: string, limit: number): [number, number] {
  const head = text.slice(0, limit + 1)
  const floor = Math.floor(limit / 2)
  for (const separator of ['\n\n', '\n']) {
    const at = head.lastIndexOf(separator, limit - separator.length)
    if (at >= floor) {
      return [at, at + separator.length]
    }
  }
  const space = Math.max(head.lastIndexOf(' ', limit), head.lastIndexOf('\t', limit))
  if (space >= floor) {
    return [space, space + 1]
  }
  const code = text.charCodeAt(limit - 1)
  const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
  return [cut, cut]
}

// What the next part starts with to reopen a block; an opener too long to repeat goes without its language.
function reopenFor(fence: Fence, max: number): string {
  return `${fence.opener.length <= max / 4 ? fence.opener : fence.marker}\n`
}

/**
 * `text` as Discord messages of at most `max` characters (UTF-16 units, which never undercounts
 * Discord's own count). A code block a split falls inside is closed at the end of one part and
 * opened again, with its language, at the start of the next. Empty text gives no messages.
 */
export function splitDiscordMessage(text: string, max = DISCORD_MESSAGE_MAX_LENGTH): string[] {
  if (max < 20) {
    throw new RangeError('A Discord message part needs room for at least 20 characters')
  }
  const parts: string[] = []
  let rest = text.replace(/^\n+/, '').trimEnd()
  let reopen = ''
  while (rest.length > 0) {
    const body = reopen + rest
    if (body.length <= max) {
      parts.push(body)
      break
    }
    let [end, next] = breakAt(body, max)
    let fence = openFence(body.slice(0, end))
    if (fence) {
      // Room for the closing fence on its own line.
      ;[end, next] = breakAt(body, max - fence.marker.length - 1)
      fence = openFence(body.slice(0, end))
      // Each part must carry more than the next one repeats; a fence too long for that splits as
      // plain text, so the loop always moves on.
      if (fence && next <= reopenFor(fence, max).length) {
        ;[end, next] = breakAt(body, max)
        fence = null
      }
    }
    const head = body.slice(0, end).trimEnd()
    parts.push(fence ? `${head}\n${fence.marker}` : head)
    reopen = fence ? reopenFor(fence, max) : ''
    rest = body.slice(next)
    if (!fence) {
      rest = rest.replace(/^\n+/, '')
    }
  }
  return parts.filter((part) => part.trim().length > 0)
}

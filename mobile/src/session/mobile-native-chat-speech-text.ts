import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'

const PATH =
  /(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?(?:[\w.!~-]+[\\/])+([\w.!~-]+\.\w{1,5})/g
const URL_PATTERN = /https?:\/\/\S+/g
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?/gu

function speakInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(URL_PATTERN, 'link')
    .replace(PATH, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)\*(\S(?:.*?\S)?)\*(?!\w)/g, '$1$2')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(\d)\s*[–-]\s*(\d)/g, '$1 to $2')
    .replace(/\s\+\s/g, ' plus ')
    .replace(/->|→/g, ' to ')
    .replace(EMOJI, '')
    .replace(/#(\d)/g, 'number $1')
    .replace(/<\/?(\w+)>/g, '$1')
    .replace(/^(?:>\s*)+/, '')
    .replace(/[`#|]/g, '')
    .replace(/_/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function withSentenceEnd(text: string): string {
  return /[.!?:;,]$/.test(text) ? text : `${text}.`
}

function speakTable(lines: string[]): string[] {
  const rows = lines
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        // A pipe escaped as \| is cell text, not a column break.
        .replace(/\\\|/g, '')
        .split('|')
        .map((cell) => cell.replace(//g, '|').trim())
    )
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell || '-')))
    .map((cells) => cells.map((cell) => (cell === '#' ? '' : speakInline(cell))))
  const [head, ...body] = rows
  if (!head) {
    return []
  }
  if (body.length === 0) {
    return [withSentenceEnd(head.filter(Boolean).join(', '))]
  }
  return body.map((cells) =>
    withSentenceEnd(
      cells
        .map((cell, index) => (cell && head[index] ? `${head[index]}: ${cell}` : cell))
        .filter(Boolean)
        .join(', ')
        .replace(/\.$/, '')
    )
  )
}

// Markdown read aloud verbatim says "asterisk" and spells out paths, so speak what the reader sees instead.
export function nativeChatSpeechText(markdown: string): string {
  const text = markdown.replace(/```[\s\S]*?```/g, '\n(code skipped)\n')
  const spoken: string[] = []
  let table: string[] = []
  for (const raw of [...text.split('\n'), '']) {
    const line = raw.trim()
    if (line.startsWith('|')) {
      table.push(line)
      continue
    }
    if (table.length > 0) {
      spoken.push(...speakTable(table))
      table = []
    }
    if (!line || /^[-*_]{3,}$/.test(line)) {
      continue
    }
    const sentence = speakInline(
      line
        .replace(/^#{1,6}\s*/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/^\[[ x]\]\s*/, '')
    )
    if (sentence) {
      spoken.push(withSentenceEnd(sentence))
    }
  }
  return spoken.join(' ').replace(/\s+/g, ' ').trim()
}

// Android's TextToSpeech rejects a single utterance over its input limit (4000 chars).
export function nativeChatSpeechChunks(text: string, maxLength = 3900): string[] {
  const chunks: string[] = []
  let current = ''
  // No lookbehind: the page also runs on iOS 15, which cannot parse it.
  for (const sentence of text.replace(/([.!?])\s+/g, '$1\n').split('\n')) {
    if (current && current.length + sentence.length + 1 > maxLength) {
      chunks.push(current)
      current = ''
    }
    current = current ? `${current} ${sentence}` : sentence
    while (current.length > maxLength) {
      chunks.push(current.slice(0, maxLength))
      current = current.slice(maxLength)
    }
  }
  if (current) {
    chunks.push(current)
  }
  return chunks
}

export function latestReplySpeechText(
  messages: readonly Pick<NativeChatMessage, 'role' | 'blocks'>[]
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    const text = nativeChatSpeechText(nativeChatMessagePlainText(message))
    if (text) {
      return text
    }
  }
  return null
}

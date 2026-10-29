import type { LinkReading } from '../storage/speech-preferences'
import { readerWords, type ReaderWords } from './reader-words'

// Android's TextToSpeech rejects longer inputs (TextToSpeech.getMaxSpeechInputLength() is 4000).
export const MAX_SPEECH_CHUNK_LENGTH = 3900

type Placeholders = Pick<ReaderWords, 'code' | 'table' | 'link'>

const FILE_EXTENSION = /\.[a-z]\w{0,4}(?::\d+)?$/i
const PATH_START = /^(?:\/|\.{1,2}[\\/]|~|[a-z]:[\\/])/i

// Why: a single slash is as often a word pair (`and/or`, `TCP/IP`) as a path.
function looksLikePath(code: string): boolean {
  const separators = code.match(/[\\/]/g)?.length ?? 0
  if (separators === 0 || /\s/.test(code)) {
    return false
  }
  return FILE_EXTENSION.test(code) || PATH_START.test(code) || separators >= 2
}

/** `src/foo/plan-aktualny.md:12` → "plan aktualny": paths read aloud are noise, the name is not. */
function speakableInlineCode(code: string): string {
  if (!looksLikePath(code)) {
    return code
  }
  const last = code.split(/[\\/]/).findLast((part) => part.length > 0) ?? code
  return last
    .replace(/:\d+$/, '')
    .replace(/\.\w{1,5}$/, '')
    .replace(/[-_]/g, ' ')
}

let linkReading: LinkReading = 'word-and-text'

export function setLinkReading(mode: LinkReading): void {
  linkReading = mode
}

const ADDRESS = /^<?https?:\/\//i
// A link's target, which may hold one level of brackets, e.g. `wiki/Foo_(bar)`, and a title.
const TARGET = String.raw`\(((?:[^()\s]|\([^()\s]*\))*)[^)]*\)`
const IMAGE = new RegExp(String.raw`!\[([^\]]*)\]${TARGET}`, 'g')
const LINK = new RegExp(String.raw`\[([^\]]+)\]${TARGET}`, 'g')

/** Punctuation after a bare address, and a ")" closing brackets around it, stay in the text. */
function addressEnd(found: string): number {
  let end = found.length
  while (end > 0) {
    const url = found.slice(0, end)
    const unbalanced = url.split(')').length > url.split('(').length
    if (!/[.,;:!?'"]$/.test(url) && !(url.endsWith(')') && unbalanced)) {
      break
    }
    end -= 1
  }
  return end
}

/** "who.int" for `https://www.who.int/…`; null for a link to a file. */
function linkSite(url: string): string | null {
  return /^<?https?:\/\/(?:www\.)?([^/:?#\s>]+)/i.exec(url)?.[1] ?? null
}

/** `label` is null for a bare address. */
function spokenLink(label: string | null, url: string, mode: LinkReading, word: string): string {
  switch (mode) {
    case 'off':
      return ''
    case 'text':
      return label ?? word
    case 'word-and-text':
      return label ? `${word} ${label}` : word
    case 'word-text-site': {
      const site = linkSite(url)
      const named = label ? `${word} ${label}` : word
      return site ? `${named}${label ? ',' : ''} ${site}` : named
    }
  }
}

/**
 * Code blocks and tables become a short cue, and every line ends as a sentence so list items get a
 * pause instead of running together.
 */
export function toSpeechText(
  markdown: string,
  placeholders: Placeholders = readerWords(),
  links = linkReading
): string {
  let text = markdown.replace(/\r/g, '')
  text = text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```[^\n]*$/gm, `\n${placeholders.code}\n`)
  text = text.replace(/(^[ \t]*\|.*\|[ \t]*(\n|$))+/gm, `${placeholders.table}\n`)
  // An image is read as its alt text; one without any is dropped.
  text = text.replace(IMAGE, (_, alt: string) => alt)
  text = text.replace(LINK, (_, label: string, url: string) =>
    spokenLink(ADDRESS.test(label) ? null : label, url, links, placeholders.link)
  )
  text = text.replace(/<?(https?:\/\/[^\s<>]+)>?/g, (_, found: string) => {
    const end = addressEnd(found)
    return spokenLink(null, found.slice(0, end), links, placeholders.link) + found.slice(end)
  })
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => speakableInlineCode(code))
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/\*\*|__|~~/g, '')
  text = text.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1')
  text = text.replace(/\s*[→⇒➜]\s*/g, ', ')
  text = text.replace(/\p{Extended_Pictographic}|️|‍/gu, '')

  return (
    text
      .split('\n')
      // A skipped link leaves the punctuation after it behind a space.
      .map((line) =>
        line
          .replace(/\s+/g, ' ')
          .replace(/\s+([.,;:!?)])/g, '$1')
          .trim()
      )
      .filter((line) => line.length > 0)
      .map((line) => (/[.!?:;,…。！？]$/.test(line) ? line : `${line}.`))
      .join(' ')
  )
}

/** Splits at sentence ends so each piece fits the platform TTS input limit. */
export function splitForSpeech(text: string, maxLength = MAX_SPEECH_CHUNK_LENGTH): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength)
    const sentenceEnd = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? ')
    )
    const cut = sentenceEnd > maxLength / 2 ? sentenceEnd + 1 : window.lastIndexOf(' ')
    const at = cut > 0 ? cut : maxLength
    chunks.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) {
    chunks.push(rest)
  }
  return chunks
}

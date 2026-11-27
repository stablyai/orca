// Deterministic provider text and the prompt directive shared by the 4a stub and its driver, so both arms see identical bytes.
const { createHash } = require('node:crypto')

const DIRECTIVE = /\[\[4a (\{[^\]]*\})\]\]/

/** A prompt that tells the stub what to emit; padding makes large prompt bodies without changing the op. */
function formatDirective(op, paddingBytes = 0) {
  const head = `[[4a ${JSON.stringify(op)}]]`
  return paddingBytes > 0 ? `${head}\n${prose(paddingBytes, op.tag ?? 'pad')}` : head
}

function parseDirective(text) {
  const match = DIRECTIVE.exec(typeof text === 'string' ? text : JSON.stringify(text ?? ''))
  if (!match) {
    return null
  }
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function seededWords(seed) {
  let state = 0
  for (const char of String(seed)) {
    state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['journal', 'stream', 'outline', 'queue', 'render', 'commit', 'reader', 'writer']

/** Block-rich markdown: headings, lists, fenced code and prose, cut to exactly `bytes` ASCII bytes. */
function prose(bytes, seed) {
  const next = seededWords(seed)
  const parts = []
  let length = 0
  for (let block = 0; length < bytes; block += 1) {
    const words = Array.from({ length: 12 }, () => WORDS[Math.floor(next() * WORDS.length)])
    const shape = block % 4
    const text =
      shape === 0
        ? `## Section ${block}\n\n${words.join(' ')}.\n\n`
        : shape === 1
          ? `${words.map((word) => `- **${word}** item`).join('\n')}\n\n`
          : shape === 2
            ? `\`\`\`ts\nconst ${words[0]}${block} = '${words.slice(1).join('-')}'\n\`\`\`\n\n`
            : `${words.join(' ')} with \`${words[1]}\` and a [link](https://example.invalid/${block}).\n\n`
    parts.push(text)
    length += text.length
  }
  return parts.join('').slice(0, bytes)
}

/** One unbroken line with no whitespace, the shape that defeats line-based chunking. */
function noBreak(bytes, seed) {
  const unit = createHash('sha256').update(String(seed)).digest('hex')
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
}

function streamText(op) {
  const body = op.shape === 'nobreak' ? noBreak : prose
  const head = `4A-FIRST-${op.tag} `
  const tail = ` 4A-END-${op.tag}`
  return `${head}${body(Math.max(0, op.bytes - head.length - tail.length), op.tag)}${tail}`
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

module.exports = { formatDirective, parseDirective, prose, noBreak, streamText, digest }

const WORD = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}`
const BOUNDARY = `(?<![${WORD}])`
const END_BOUNDARY = `(?![${WORD}])`
const BEARER = new RegExp(
  `${BOUNDARY}[Bb][Ee][Aa][Rr][Ee][Rr][ \\t]+[A-Za-z0-9._~+/-]{16,}=*`,
  'gu'
)
const AWS_ID = new RegExp(`${BOUNDARY}AKIA[0-9A-Z]{16}${END_BOUNDARY}`, 'gu')
const ASSIGNMENT = new RegExp(
  `${BOUNDARY}(api[_-]?key|token|secret|password)${END_BOUNDARY}(\\p{White_Space}*[:=]\\p{White_Space}*)(["']?)[^\\p{White_Space}"']{8,}`,
  'giu'
)

export function redactCodexCommand(text: string): string {
  return text
    .replace(BEARER, 'Bearer [REDACTED_SECRET]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_SECRET]')
    .replace(AWS_ID, '[REDACTED_SECRET]')
    .replace(ASSIGNMENT, '$1$2$3[REDACTED_SECRET]')
}

// Match the provider's shlex 1.3 presentation, including its greedy mixed-quote chunks.
function quoteWord(word: string): string {
  if (!word) {
    return "''"
  }
  let output = ''
  for (let start = 0; start < word.length;) {
    let allowed = word[start] === '^' ? 2 : 7
    let end = start + (word[start] === '^' ? 1 : 0)
    while (end < word.length) {
      const char = word[end]!
      let next = allowed
      if (!/^[A-Za-z0-9+./:@\]_-]$/.test(char)) {
        next &= ~1
      }
      if ("'^\\".includes(char)) {
        next &= ~2
      }
      if ('`$!^'.includes(char)) {
        next &= ~4
      }
      if (!next) {
        break
      }
      allowed = next
      end++
    }
    const chunk = word.slice(start, end)
    output +=
      allowed & 1 ? chunk : allowed & 2 ? `'${chunk}'` : `"${chunk.replace(/["\\]/g, '\\$&')}"`
    start = end
  }
  return output
}

export function codexCommandPresentation(argv: readonly string[]): string {
  return redactCodexCommand(
    argv.some((word) => word.includes('\0'))
      ? '<command included NUL byte>'
      : argv.map(quoteWord).join(' ')
  )
}

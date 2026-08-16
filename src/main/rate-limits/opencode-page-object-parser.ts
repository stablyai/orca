const OBJECT_LOOKBACK_LIMIT = 100_000
const OBJECT_FORWARD_LIMIT = 100_000
const OBJECT_CANDIDATE_LIMIT = 64
const FIELD_SCAN_LENGTH = 256

function findObjectEnd(text: string, openBrace: number): number | null {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false

  const scanEnd = Math.min(text.length, openBrace + OBJECT_FORWARD_LIMIT)
  for (let index = openBrace; index < scanEnd; index++) {
    const character = text[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (character === '{') {
      depth++
    } else if (character === '}' && --depth === 0) {
      return index
    }
  }
  return null
}

function extractEmbeddedObjectAt(text: string, openBrace: number): string | null {
  if (text[openBrace] !== '{') {
    return null
  }
  const end = findObjectEnd(text, openBrace)
  return end === null ? null : text.slice(openBrace, end + 1)
}

export function extractEmbeddedObjectAfterKey(
  text: string,
  keyPattern: RegExp,
  isExpectedObject: (block: string) => boolean
): string | null {
  for (const match of text.matchAll(keyPattern)) {
    const searchStart = (match.index ?? 0) + match[0].length
    const braceOffset = text.slice(searchStart, searchStart + 40).indexOf('{')
    if (braceOffset < 0) {
      continue
    }
    const block = extractEmbeddedObjectAt(text, searchStart + braceOffset)
    if (block && isExpectedObject(block)) {
      return block
    }
  }
  return null
}

export function extractEnclosingEmbeddedObject(text: string, offset: number): string | null {
  const earliestStart = Math.max(0, offset - OBJECT_LOOKBACK_LIMIT)
  let candidatesChecked = 0
  for (
    let openBrace = text.lastIndexOf('{', offset);
    openBrace >= earliestStart && candidatesChecked < OBJECT_CANDIDATE_LIMIT;
    openBrace = text.lastIndexOf('{', openBrace - 1)
  ) {
    candidatesChecked++
    const end = findObjectEnd(text, openBrace)
    if (end !== null && end >= offset) {
      return text.slice(openBrace, end + 1)
    }
  }
  return null
}

export function findEmbeddedTopLevelMatch(
  objectText: string,
  fieldPattern: RegExp
): RegExpExecArray | null {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false

  for (let index = 0; index < objectText.length; index++) {
    const character = objectText[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (depth === 1) {
      const match = fieldPattern.exec(objectText.slice(index, index + FIELD_SCAN_LENGTH))
      if (match?.index === 0) {
        return match
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '{') {
      depth++
      continue
    }
    if (character === '}') {
      depth--
      continue
    }
  }
  return null
}

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

const USER_VISIBLE_ATTRIBUTE_RE =
  /\b(aria-description|aria-label|alt|data-placeholder|placeholder|title)\s*=\s*(["'])(.*?)\2/gi
const USER_VISIBLE_PROMPT_START_RE = /\b(?:window\.)?(alert|confirm|prompt)\(\s*/g
const INSERTED_HTML_CALL_RE = /\bexecCommand\(\s*(["'])insertHTML\1\s*,\s*false\s*,/g

function maskNonMarkupContent(documentText) {
  return documentText.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (value) =>
    value.replace(/[^\n]/g, ' ')
  )
}

function capturedOffset(match, capturedValue) {
  return (match.index ?? 0) + match[0].indexOf(capturedValue)
}

function collectTextCandidates(value, baseOffset, kind, candidates) {
  if (!value.includes('${')) {
    candidates.push({
      start: baseOffset,
      end: baseOffset + value.length,
      kind,
      text: value,
      dynamic: false
    })
    return
  }

  let cursor = 0
  while (cursor < value.length) {
    const interpolationStart = value.indexOf('${', cursor)
    const segmentEnd = interpolationStart === -1 ? value.length : interpolationStart
    if (segmentEnd > cursor) {
      candidates.push({
        start: baseOffset + cursor,
        end: baseOffset + segmentEnd,
        kind,
        text: value.slice(cursor, segmentEnd),
        dynamic: true
      })
    }
    if (interpolationStart === -1) {
      break
    }
    cursor = skipTemplateInterpolation(value, interpolationStart)
  }
}

function collectMarkupCandidates(markup, baseOffset, candidates) {
  for (const match of markup.matchAll(USER_VISIBLE_ATTRIBUTE_RE)) {
    const value = match[3]
    collectTextCandidates(
      value,
      baseOffset + capturedOffset(match, value),
      `embedded-html-attribute:${match[1].toLowerCase()}`,
      candidates
    )
  }

  for (const match of markup.matchAll(/>([^<]+)</g)) {
    const value = match[1]
    collectTextCandidates(
      value,
      baseOffset + capturedOffset(match, value),
      'embedded-html-text',
      candidates
    )
  }
}

function collectMarkupFragmentCandidates(markup, baseOffset, candidates) {
  collectMarkupCandidates(markup, baseOffset, candidates)

  for (const match of [markup.match(/^([^<]+)</), markup.match(/>([^<]+)$/)]) {
    if (!match) {
      continue
    }
    const value = match[1]
    const start = baseOffset + capturedOffset(match, value)
    collectTextCandidates(value, start, 'embedded-html-text', candidates)
  }
}

function skipQuotedString(source, start) {
  const quote = source[start]
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2
    } else if (source[cursor] === quote) {
      return cursor + 1
    } else {
      cursor += 1
    }
  }
  return source.length
}

function skipTemplateInterpolation(source, start) {
  let depth = 1
  let cursor = start + 2
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === '"' || source[cursor] === "'") {
      cursor = skipQuotedString(source, cursor)
    } else {
      if (source[cursor] === '{') {
        depth += 1
      }
      if (source[cursor] === '}') {
        depth -= 1
      }
      cursor += 1
    }
  }
  return cursor
}

function templateLiteralEnd(source, start) {
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2
    } else if (source.startsWith('${', cursor)) {
      cursor = skipTemplateInterpolation(source, cursor)
    } else if (source[cursor] === '`') {
      return cursor + 1
    } else {
      cursor += 1
    }
  }
  return source.length
}

function escapedTemplateLiteralEnd(source, start) {
  let cursor = start + 2
  while (cursor < source.length) {
    if (source.startsWith('${', cursor)) {
      cursor = skipTemplateInterpolation(source, cursor)
    } else if (source.startsWith('\\`', cursor)) {
      return cursor + 2
    } else if (source[cursor] === '\\') {
      cursor += 2
    } else {
      cursor += 1
    }
  }
  return source.length
}

function collectPromptCandidates(documentText, baseOffset, candidates) {
  for (const match of documentText.matchAll(USER_VISIBLE_PROMPT_START_RE)) {
    const argumentStart = (match.index ?? 0) + match[0].length
    const quote = documentText[argumentStart]
    const escapedTemplate = quote === '\\' && documentText[argumentStart + 1] === '`'
    if (quote !== '"' && quote !== "'" && quote !== '`' && !escapedTemplate) {
      continue
    }
    const argumentEnd = escapedTemplate
      ? escapedTemplateLiteralEnd(documentText, argumentStart)
      : quote === '`'
        ? templateLiteralEnd(documentText, argumentStart)
        : skipQuotedString(documentText, argumentStart)
    const valueStart = argumentStart + (escapedTemplate ? 2 : 1)
    const valueEnd = argumentEnd - (escapedTemplate ? 2 : 1)
    const value = documentText.slice(valueStart, valueEnd)
    collectTextCandidates(
      value,
      baseOffset + valueStart,
      `embedded-web-${match[1].toLowerCase()}`,
      candidates
    )
  }
}

function insertedHtmlArgumentEnd(source, start) {
  let depth = 1
  let cursor = start
  while (cursor < source.length) {
    if (source[cursor] === '"' || source[cursor] === "'") {
      cursor = skipQuotedString(source, cursor)
      continue
    }
    if (source[cursor] === '`') {
      cursor = templateLiteralEnd(source, cursor)
      continue
    }
    if (source[cursor] === '\\' && source[cursor + 1] === '`') {
      cursor = escapedTemplateLiteralEnd(source, cursor)
      continue
    }
    if (source[cursor] === '(') {
      depth += 1
    }
    if (source[cursor] === ')') {
      depth -= 1
      if (depth === 0) {
        return cursor
      }
    }
    cursor += 1
  }
  return source.length
}

function collectInsertedHtmlCandidates(expression, baseOffset, candidates) {
  let cursor = 0
  while (cursor < expression.length) {
    if (expression.startsWith('${', cursor)) {
      cursor = skipTemplateInterpolation(expression, cursor)
      continue
    }
    if (expression[cursor] === '"' || expression[cursor] === "'") {
      const end = skipQuotedString(expression, cursor)
      const markup = expression.slice(cursor + 1, end - 1)
      collectMarkupFragmentCandidates(markup, baseOffset + cursor + 1, candidates)
      cursor = end
      continue
    }
    const escapedTemplate = expression[cursor] === '\\' && expression[cursor + 1] === '`'
    if (expression[cursor] === '`' || escapedTemplate) {
      const end = escapedTemplate
        ? escapedTemplateLiteralEnd(expression, cursor)
        : templateLiteralEnd(expression, cursor)
      const delimiterWidth = escapedTemplate ? 2 : 1
      const markup = expression.slice(cursor + delimiterWidth, end - delimiterWidth)
      collectMarkupFragmentCandidates(markup, baseOffset + cursor + delimiterWidth, candidates)
      cursor = end
      continue
    }
    cursor += 1
  }
}

export function collectMobileEmbeddedDocumentCandidates(filePath, sourceText) {
  const sourceKind =
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const candidates = []

  function visit(node) {
    if (
      (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /<!doctype html/i.test(node.getText(sourceFile))
    ) {
      const documentText = node.getText(sourceFile).slice(1, -1)
      const baseOffset = node.getStart(sourceFile) + 1
      collectMarkupCandidates(maskNonMarkupContent(documentText), baseOffset, candidates)

      collectPromptCandidates(documentText, baseOffset, candidates)

      for (const match of documentText.matchAll(INSERTED_HTML_CALL_RE)) {
        const argumentStart = (match.index ?? 0) + match[0].length
        const argumentEnd = insertedHtmlArgumentEnd(documentText, argumentStart)
        collectInsertedHtmlCandidates(
          documentText.slice(argumentStart, argumentEnd),
          baseOffset + argumentStart,
          candidates
        )
      }
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return candidates
}

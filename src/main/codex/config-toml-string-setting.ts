import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

type Edit = { start: number; end: number; text: string }
const prefixOf = (prefix: string[], path: string[]) => prefix.every((key, i) => key === path[i])
const renderString = (value: string) => JSON.stringify(value).replace(/\x7f/g, '\\u007f')
const applyEdit = (content: string, edit: Edit) =>
  content.slice(0, edit.start) + edit.text + content.slice(edit.end)

/** Edits one string without reserializing the user's unrelated TOML. */
export function editTomlStringSetting(
  content: string,
  path: string[],
  value: string | null
): string {
  let state = createTomlLineScanState()
  let table: string[] = []
  let offset = 0
  let insertion = { offset: 0, prefix: [] as string[] }
  for (const line of content.split('\n')) {
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        const parsed = parseTomlTableHeaderPath(header)
        table = parsed && !parsed.isArray ? parsed.segments : ['']
        if (
          table.length < path.length &&
          prefixOf(table, path) &&
          table.length > insertion.prefix.length
        ) {
          insertion = { offset: offset + line.length + 1, prefix: table }
        }
      } else {
        const key = parseTomlKeyPath(line)
        const fullPath = key ? [...table, ...key.segments] : []
        if (key && line[key.end] === '=' && prefixOf(fullPath, path)) {
          const start = skipWhitespace(content, offset + key.end + 1)
          const end = valueEnd(content, start)
          if (fullPath.length === path.length) {
            return applyEdit(
              content,
              value === null
                ? {
                    start: offset,
                    end: !content.includes('\n', end)
                      ? content.length
                      : content.indexOf('\n', end) + 1,
                    text: ''
                  }
                : { start, end, text: renderString(value) }
            )
          }
          if (content[start] !== '{') {
            throw new Error('Codex shell environment setting is not a TOML table')
          }
          const edit = editInlineTable(content, start, path.slice(fullPath.length), value)
          return edit ? applyEdit(content, edit) : content
        }
      }
    }
    state = updateTomlLineScanState(state, line)
    offset += line.length + 1
  }
  if (value === null) {
    return content
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const at = Math.min(insertion.offset, content.length)
  const leading = at > 0 && content[at - 1] !== '\n' ? newline : ''
  const assignment = `${path.slice(insertion.prefix.length).join('.')} = ${renderString(value)}${newline}`
  return applyEdit(content, { start: at, end: at, text: leading + assignment })
}

function editInlineTable(
  source: string,
  start: number,
  path: string[],
  value: string | null
): Edit | null {
  let cursor = skipWhitespace(source, start + 1)
  let previousComma = -1
  while (source[cursor] !== '}') {
    const keyStart = cursor
    const key = parseTomlKeyPath(source, cursor)
    if (!key || source[key.end] !== '=') {
      throw new Error('Invalid inline TOML setting')
    }
    const startValue = skipWhitespace(source, key.end + 1)
    const endValue = valueEnd(source, startValue)
    const next = skipWhitespace(source, endValue)
    if (prefixOf(key.segments, path)) {
      if (key.segments.length < path.length) {
        if (source[startValue] !== '{') {
          throw new Error('Invalid nested inline TOML setting')
        }
        return editInlineTable(source, startValue, path.slice(key.segments.length), value)
      }
      if (value !== null) {
        return { start: startValue, end: endValue, text: renderString(value) }
      }
      return source[next] === ','
        ? { start: keyStart, end: next + 1, text: '' }
        : { start: previousComma < 0 ? keyStart : previousComma, end: endValue, text: '' }
    }
    if (source[next] === '}') {
      cursor = next
      break
    }
    if (source[next] !== ',') {
      throw new Error('Invalid inline TOML separator')
    }
    previousComma = next
    cursor = skipWhitespace(source, next + 1)
  }
  if (value === null) {
    return null
  }
  const separator = source.slice(start + 1, cursor).trim() ? ', ' : ''
  return {
    start: cursor,
    end: cursor,
    text: `${separator}${path.join('.')} = ${renderString(value)}`
  }
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/[ \t\r\n]/.test(source[index] ?? '') && index < source.length) {
    index += 1
  }
  return index
}

function valueEnd(source: string, start: number): number {
  const string = parseTomlStringValue(source, start)
  if (string) {
    let end = string.end
    const quote = source[start]
    if (source.startsWith('"""', start) || source.startsWith("'''", start)) {
      // TOML permits one or two quote characters immediately before the closing delimiter.
      while (end < string.end + 2 && source[end] === quote) {
        end += 1
      }
    }
    return end
  }
  const closing = source[start] === '{' ? '}' : source[start] === '[' ? ']' : null
  let index = start + (closing ? 1 : 0)
  if (closing) {
    while (index < source.length && source[index] !== closing) {
      if (source[index] === '#') {
        const newline = source.indexOf('\n', index)
        index = newline === -1 ? source.length : newline + 1
      } else if (
        source[index] === '"' ||
        source[index] === "'" ||
        source[index] === '{' ||
        source[index] === '['
      ) {
        index = valueEnd(source, index)
      } else {
        index += 1
      }
    }
    if (source[index] !== closing) {
      throw new Error('Unclosed TOML setting')
    }
    return index + 1
  }
  while (index < source.length && !/[,}\]\r\n#]/.test(source[index]!)) {
    index += 1
  }
  while (index > start && /[ \t]/.test(source[index - 1]!)) {
    index -= 1
  }
  if (index === start) {
    throw new Error('Missing TOML setting value')
  }
  return index
}

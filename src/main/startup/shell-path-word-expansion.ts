import { statSync } from 'node:fs'
import path from 'node:path'

export const PATH_REF = '\0ORCA_PATH_REF\0'

const POSIX_PATH_DELIMITER = ':'

export type ShellPathParseContext = {
  env: NodeJS.ProcessEnv
  homePath: string
  variables: Map<string, string>
}

export function expandPathWords(
  words: string[],
  context: ShellPathParseContext,
  current: string[]
): string[] {
  const expanded: string[] = []
  for (const word of words) {
    const value = expandShellWord(word, context)
    if (!value) {
      continue
    }
    if (value === PATH_REF) {
      expanded.push(...current)
      continue
    }
    if (!value.includes(PATH_REF) && isExistingDirectory(value)) {
      expanded.push(value)
    }
  }
  return expanded
}

export function expandShellWord(rawValue: string, context: ShellPathParseContext): string | null {
  if (rawValue.includes('$(') || rawValue.includes('`')) {
    return null
  }
  let result = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index]
    if (char === '\\') {
      const next = rawValue[index + 1]
      result += next ?? ''
      index += 1
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char
      continue
    }
    if (!quote && char === '~' && result.length === 0) {
      result += context.homePath
      continue
    }
    if (quote !== "'" && char === '$') {
      const expanded = expandVariable(rawValue, index, context)
      if (!expanded) {
        return null
      }
      result += expanded.value
      index = expanded.endIndex
      continue
    }
    result += char
  }
  return result.trim()
}

function expandVariable(
  rawValue: string,
  dollarIndex: number,
  context: ShellPathParseContext
): { value: string; endIndex: number } | null {
  if (rawValue[dollarIndex + 1] === '{') {
    const endBrace = rawValue.indexOf('}', dollarIndex + 2)
    if (endBrace < 0) {
      return null
    }
    const name = rawValue.slice(dollarIndex + 2, endBrace)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return null
    }
    const value = getVariableValue(name, context)
    return value === null ? null : { value, endIndex: endBrace }
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rawValue.slice(dollarIndex + 1))
  if (!match) {
    return null
  }
  const name = match[0]
  const value = getVariableValue(name, context)
  return value === null ? null : { value, endIndex: dollarIndex + name.length }
}

function getVariableValue(name: string, context: ShellPathParseContext): string | null {
  if (name === 'PATH' || name === 'path') {
    return PATH_REF
  }
  return context.variables.get(name) ?? null
}

export function splitPathExpression(expression: string): string[] {
  const value = unwrapOuterQuotes(expression.trim())
  const parts = value.split(POSIX_PATH_DELIMITER)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function unwrapOuterQuotes(value: string): string {
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    return value.slice(1, -1)
  }
  return value
}

export function splitShellWords(expression: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (char === '\\') {
      current += char + (expression[index + 1] ?? '')
      index += 1
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char
      current += char
      continue
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) {
    words.push(current)
  }
  return words
}

export function stripShellComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char
      continue
    }
    if (!quote && char === '#') {
      return line.slice(0, index)
    }
  }
  return line
}

export function readShellValue(line: string, start: number): { value: string; end: number } {
  const quote = line[start] === '"' || line[start] === "'" ? line[start] : null
  if (quote) {
    let index = start + 1
    while (index < line.length) {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line[index] === quote) {
        return { value: line.slice(start, index + 1), end: index + 1 }
      }
      index += 1
    }
    return { value: line.slice(start), end: line.length }
  }

  let end = start
  while (end < line.length && !/\s|;/.test(line[end])) {
    end += 1
  }
  return { value: line.slice(start, end), end }
}

export function skipSpaces(value: string, start: number): number {
  let index = start
  while (index < value.length && /\s/.test(value[index])) {
    index += 1
  }
  return index
}

export function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value)
}

function isExistingDirectory(value: string): boolean {
  if (!path.isAbsolute(value)) {
    return false
  }
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

export function uniqueSegments(segments: string[]): string[] {
  return [...new Set(segments.filter(Boolean))]
}

export function sameSegments(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

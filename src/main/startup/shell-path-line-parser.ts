import {
  PATH_REF,
  expandPathWords,
  expandShellWord,
  isIdentifierChar,
  readShellValue,
  skipSpaces,
  splitPathExpression,
  splitShellWords,
  stripShellComment,
  uniqueSegments,
  type ShellPathParseContext
} from './shell-path-word-expansion'

type PathAssignment = {
  value: string
  append: boolean
}

export function applyShellStartupText(
  content: string,
  baseSegments: string[],
  context: ShellPathParseContext
): string[] {
  let segments = baseSegments
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripShellComment(rawLine).trim()
    if (!line) {
      continue
    }

    rememberScalarAssignment(line, context)
    for (const assignment of findPathAssignments(line)) {
      segments = applyPathExpression(assignment.value, segments, context, assignment.append)
    }
    for (const expression of findZshPathArrays(line)) {
      segments = applyPathWords(splitShellWords(expression), segments, context)
    }
    for (const command of findFishAddPathCommands(line)) {
      segments = applyFishAddPath(command, segments, context)
    }
    for (const expression of findFishSetPathCommands(line)) {
      segments = applyPathWords(splitShellWords(expression), segments, context)
    }
  }
  return segments
}

function rememberScalarAssignment(line: string, context: ShellPathParseContext): void {
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;]+)/.exec(line)
  if (!match || match[1] === 'PATH' || match[1] === 'path') {
    return
  }
  const rawValue = match[0].slice(match[0].indexOf('=') + 1)
  const expanded = expandShellWord(rawValue, context)
  if (expanded && !expanded.includes(PATH_REF)) {
    context.variables.set(match[1], expanded)
  }
}

function findPathAssignments(line: string): PathAssignment[] {
  const assignments: PathAssignment[] = []
  let searchIndex = 0
  while (searchIndex < line.length) {
    const pathIndex = line.indexOf('PATH', searchIndex)
    if (pathIndex < 0) {
      break
    }
    searchIndex = pathIndex + 'PATH'.length
    if (isIdentifierChar(line[pathIndex - 1]) || isIdentifierChar(line[searchIndex])) {
      continue
    }
    let cursor = skipSpaces(line, searchIndex)
    const append = line[cursor] === '+'
    if (append) {
      cursor += 1
    }
    if (line[cursor] !== '=') {
      continue
    }
    cursor = skipSpaces(line, cursor + 1)
    const { value, end } = readShellValue(line, cursor)
    if (value) {
      assignments.push({ value, append })
    }
    searchIndex = Math.max(end, searchIndex)
  }
  return assignments
}

function findZshPathArrays(line: string): string[] {
  const arrays: string[] = []
  const pattern = /(?:^|[\s;])path\s*=\s*\(/g
  while (pattern.exec(line)) {
    const start = pattern.lastIndex
    const end = line.indexOf(')', start)
    if (end >= 0) {
      arrays.push(line.slice(start, end))
      pattern.lastIndex = end + 1
    }
  }
  return arrays
}

function findFishAddPathCommands(line: string): string[] {
  return findCommandArguments(line, 'fish_add_path')
}

function findFishSetPathCommands(line: string): string[] {
  return findCommandArguments(line, 'set')
    .map((args) => splitShellWords(args))
    .filter((words) => words.includes('PATH'))
    .map((words) => words.slice(words.indexOf('PATH') + 1).join(' '))
}

function findCommandArguments(line: string, command: string): string[] {
  const commands: string[] = []
  let searchIndex = 0
  while (searchIndex < line.length) {
    const commandIndex = line.indexOf(command, searchIndex)
    if (commandIndex < 0) {
      break
    }
    searchIndex = commandIndex + command.length
    if (isIdentifierChar(line[commandIndex - 1]) || isIdentifierChar(line[searchIndex])) {
      continue
    }
    const end = findCommandEnd(line, searchIndex)
    commands.push(line.slice(searchIndex, end).trim())
    searchIndex = end + 1
  }
  return commands
}

function findCommandEnd(line: string, start: number): number {
  let quote: '"' | "'" | null = null
  for (let index = start; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char
      continue
    }
    if (!quote && (char === ';' || char === '&')) {
      return index
    }
  }
  return line.length
}

function applyFishAddPath(
  command: string,
  current: string[],
  context: ShellPathParseContext
): string[] {
  const words = splitShellWords(command)
  const append = words.includes('-a') || words.includes('--append')
  const pathWords = words.filter((word) => word && !word.startsWith('-'))
  const directories = expandPathWords(pathWords, context, current)
  if (directories.length === 0) {
    return current
  }
  return append
    ? uniqueSegments([...current, ...directories])
    : uniqueSegments([...directories, ...current])
}

function applyPathExpression(
  expression: string,
  current: string[],
  context: ShellPathParseContext,
  append: boolean
): string[] {
  const parts = splitPathExpression(expression)
  const expanded = expandPathWords(parts, context, current)
  if (expanded.length === 0) {
    return current
  }
  if (append) {
    return uniqueSegments([...current, ...expanded])
  }
  const hasPathReference = parts.some((part) => expandShellWord(part, context) === PATH_REF)
  return hasPathReference ? uniqueSegments(expanded) : uniqueSegments([...expanded, ...current])
}

function applyPathWords(
  words: string[],
  current: string[],
  context: ShellPathParseContext
): string[] {
  const expanded = expandPathWords(words, context, current)
  if (expanded.length === 0) {
    return current
  }
  const hasPathReference = words.some((word) => expandShellWord(word, context) === PATH_REF)
  return hasPathReference ? uniqueSegments(expanded) : uniqueSegments([...expanded, ...current])
}

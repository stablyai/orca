import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'fs'
import { homedir, hostname, userInfo } from 'os'
import { posix, win32 } from 'path'

type PathApi = typeof posix | typeof win32

type IncludeExpansionContext = {
  cache: Map<string, string>
  home: string
  pathApi: PathApi
  rootDir: string
  shortHostname: string
  uid?: string
  username: string
}

const MAX_INCLUDE_GLOB_MATCHES = 256
const MAX_INCLUDE_FILE_BYTES = 1024 * 1024
const TARGET_DEPENDENT_INCLUDE_TOKENS = new Set(['h', 'n', 'p', 'r', 'j', 'k', 'C'])

export function expandSshConfigIncludes(configPath: string): string {
  const home = homedir()
  const pathApi = getPathApi(configPath)
  const currentUser = getCurrentUser()
  const localHostname = hostname()

  const context: IncludeExpansionContext = {
    cache: new Map(),
    home,
    pathApi,
    rootDir: pathApi.dirname(configPath),
    shortHostname: localHostname.split('.')[0] || localHostname,
    uid: getCurrentUid(),
    username: currentUser
  }

  return expandSshConfigFile(configPath, context, []).join('\n')
}

function expandSshConfigFile(
  filePath: string,
  context: IncludeExpansionContext,
  activeStack: string[]
): string[] {
  const canonicalPath = getCanonicalPath(filePath)
  if (!canonicalPath || activeStack.includes(canonicalPath)) {
    return []
  }

  const rawContent = readCachedFile(canonicalPath, context)
  if (rawContent === null) {
    return []
  }

  const expandedLines: string[] = []
  const nextStack = [...activeStack, canonicalPath]

  for (const line of rawContent.split(/\r?\n/)) {
    const includeArgs = parseIncludeDirective(line)
    if (!includeArgs) {
      expandedLines.push(line)
      continue
    }

    for (const includeArg of includeArgs) {
      for (const matchedPath of resolveIncludePaths(includeArg, context)) {
        appendExpandedLines(expandedLines, expandSshConfigFile(matchedPath, context, nextStack))
      }
    }
  }

  return expandedLines
}

function appendExpandedLines(target: string[], lines: readonly string[]): void {
  // Why: SSH config includes are user-controlled files, and a large included
  // file can exceed the JavaScript call argument limit when spread into push.
  for (const line of lines) {
    target.push(line)
  }
}

function readCachedFile(filePath: string, context: IncludeExpansionContext): string | null {
  const cached = context.cache.get(filePath)
  if (cached !== undefined) {
    return cached
  }

  if (!isReadableRegularFile(filePath)) {
    return null
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    context.cache.set(filePath, content)
    return content
  } catch {
    return null
  }
}

function parseIncludeDirective(line: string): string[] | null {
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }

  const match = trimmed.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
  if (!match || match[1].toLowerCase() !== 'include') {
    return null
  }

  const args = splitQuotedArguments(match[2])
  return args.length > 0 ? args : null
}

function splitQuotedArguments(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (inQuotes && char === '\\' && input[i + 1] === '"') {
      current += '"'
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (!inQuotes && char === '#') {
      break
    }

    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    args.push(current)
  }

  return args
}

function resolveIncludePaths(pattern: string, context: IncludeExpansionContext): string[] {
  const withEnv = expandEnvironmentVariables(pattern)
  if (withEnv === null) {
    return []
  }

  const withTokens = expandIncludeTokens(withEnv, context)
  if (withTokens === null) {
    return []
  }

  const absolutePattern = resolveIncludePatternPath(withTokens, context)
  if (hasGlobPattern(absolutePattern)) {
    try {
      const matches = globSync(absolutePattern).sort((left, right) => left.localeCompare(right))
      if (matches.length > MAX_INCLUDE_GLOB_MATCHES) {
        console.warn(
          `[ssh] Include pattern "${absolutePattern}" matched ${matches.length} files; processing first ${MAX_INCLUDE_GLOB_MATCHES}`
        )
        return matches.slice(0, MAX_INCLUDE_GLOB_MATCHES)
      }
      return matches
    } catch {
      return []
    }
  }

  return existsSync(absolutePattern) ? [absolutePattern] : []
}

function expandEnvironmentVariables(input: string): string | null {
  let missing = false
  const expanded = input.replaceAll(/\$\{([^}]+)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (value === undefined) {
      missing = true
      return ''
    }
    return value
  })

  return missing ? null : expanded
}

function expandIncludeTokens(input: string, context: IncludeExpansionContext): string | null {
  let output = ''

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char !== '%') {
      output += char
      continue
    }

    const token = input[i + 1]
    if (!token) {
      output += char
      continue
    }

    if (token === '%') {
      output += '%'
      i += 1
      continue
    }

    if (TARGET_DEPENDENT_INCLUDE_TOKENS.has(token)) {
      return null
    }

    if (token === 'd') {
      output += context.home
      i += 1
      continue
    }

    if (token === 'u') {
      output += context.username
      i += 1
      continue
    }

    if (token === 'i') {
      if (!context.uid) {
        return null
      }
      output += context.uid
      i += 1
      continue
    }

    if (token === 'l') {
      output += hostname()
      i += 1
      continue
    }

    if (token === 'L') {
      output += context.shortHostname
      i += 1
      continue
    }

    output += `%${token}`
    i += 1
  }

  return output
}

function resolveIncludePatternPath(input: string, context: IncludeExpansionContext): string {
  const pathApi = context.pathApi
  if (input === '~') {
    return context.home
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return pathApi.join(context.home, input.slice(2))
  }

  if (pathApi.isAbsolute(input)) {
    return pathApi.normalize(input)
  }

  return pathApi.normalize(pathApi.join(context.rootDir, input))
}

function hasGlobPattern(input: string): boolean {
  return /[*?[]/.test(input)
}

function getCanonicalPath(filePath: string): string | null {
  try {
    return realpathSync.native(filePath)
  } catch {
    return null
  }
}

function isReadableRegularFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      console.warn(`[ssh] Skipping SSH config include "${filePath}": not a regular file`)
      return false
    }
    if (stats.size > MAX_INCLUDE_FILE_BYTES) {
      console.warn(
        `[ssh] Skipping SSH config include "${filePath}": size ${stats.size} exceeds ${MAX_INCLUDE_FILE_BYTES} bytes`
      )
      return false
    }
    return true
  } catch {
    return false
  }
}

function getCurrentUid(): string | undefined {
  try {
    const info = userInfo()
    if (typeof info.uid === 'number' && info.uid >= 0) {
      return String(info.uid)
    }
  } catch {
    return undefined
  }

  if (typeof process.getuid === 'function') {
    try {
      return String(process.getuid())
    } catch {
      return undefined
    }
  }

  return undefined
}

function getCurrentUser(): string {
  try {
    const info = userInfo()
    if (info.username) {
      return info.username
    }
  } catch {
    // Fall back to environment variables below.
  }

  return process.env.USER ?? process.env.USERNAME ?? ''
}

function getPathApi(filePath: string): PathApi {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') ? win32 : posix
}

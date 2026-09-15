import { globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { findGlobExpansionUncertainty, hasGlobPattern } from './ssh-config-include-glob-readability'
import {
  expandEnvironmentVariables,
  expandIncludeTokens,
  getCurrentUid,
  getCurrentUser,
  getPathApi,
  resolveIncludePatternPath,
  type IncludePathContext
} from './ssh-config-include-path-resolution'

type SshConfigExpansion = {
  content: string
  /** False when an Include may have hidden config from the parser. */
  fullyExpanded: boolean
}

type IncludeExpansionContext = IncludePathContext & {
  cache: Map<string, string>
  fullyExpanded: boolean
}

const MAX_INCLUDE_GLOB_MATCHES = 256
const MAX_INCLUDE_FILE_BYTES = 1024 * 1024

export function expandSshConfigIncludes(configPath: string): SshConfigExpansion {
  const home = homedir()
  const pathApi = getPathApi(configPath)
  const localHostname = hostname()

  const context: IncludeExpansionContext = {
    cache: new Map(),
    fullyExpanded: true,
    home,
    pathApi,
    rootDir: pathApi.dirname(configPath),
    shortHostname: localHostname.split('.')[0] || localHostname,
    uid: getCurrentUid(),
    username: getCurrentUser()
  }

  const lines = expandSshConfigFile(configPath, context, [])
  return { content: lines.join('\n'), fullyExpanded: context.fullyExpanded }
}

function markIncomplete(context: IncludeExpansionContext, target: string): void {
  context.fullyExpanded = false
  console.warn(`[ssh] Could not expand SSH config Include "${target}"; hosts may be missing`)
}

function expandSshConfigFile(
  filePath: string,
  context: IncludeExpansionContext,
  activeStack: string[]
): string[] {
  const canonicalPath = getCanonicalPath(filePath, context)
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

  if (!isReadableRegularFile(filePath, context)) {
    return null
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    context.cache.set(filePath, content)
    return content
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, filePath)
    }
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
    markIncomplete(context, pattern)
    return []
  }

  const withTokens = expandIncludeTokens(withEnv, context)
  if (withTokens === null) {
    markIncomplete(context, pattern)
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
        context.fullyExpanded = false
        return matches.slice(0, MAX_INCLUDE_GLOB_MATCHES)
      }
      // Unconditional, not only on an empty result: a partial expansion is exactly as unproven, and
      // it is the half that goes on to feed a confident alias claim.
      const uncertainTarget = findGlobExpansionUncertainty(absolutePattern, context.pathApi)
      if (uncertainTarget) {
        markIncomplete(context, uncertainTarget)
      }
      return matches
    } catch {
      // A glob that threw walked a directory it could not read; it never proved the set is empty.
      markIncomplete(context, absolutePattern)
      return []
    }
  }

  // Not existsSync: it answers false for a path it merely could not stat, which would drop an
  // Include living behind an unreadable parent directory as if the user had never written it.
  try {
    statSync(absolutePattern)
    return [absolutePattern]
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, absolutePattern)
    }
    return []
  }
}

function getCanonicalPath(filePath: string, context: IncludeExpansionContext): string | null {
  try {
    return realpathSync.native(filePath)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, filePath)
    }
    return null
  }
}

function isReadableRegularFile(filePath: string, context: IncludeExpansionContext): boolean {
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
      context.fullyExpanded = false
      return false
    }
    return true
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, filePath)
    }
    return false
  }
}

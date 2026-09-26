import { globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  createGlobReadabilityProofs,
  findGlobExpansionUncertainty,
  hasGlobPattern,
  type GlobExpansionUncertainty,
  type GlobReadabilityProofs
} from './ssh-config-include-glob-readability'
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
  /** Shared across every Include so one ~/.ssh is enumerated once per expansion, not once per glob. */
  globProofs: GlobReadabilityProofs
}

type ResolvedIncludePaths = {
  paths: string[]
  /**
   * What to log in place of a resolved path, or `null` when the resolved path is safe to log.
   *
   * `${VAR}` expansion can substitute a directory the user keeps secret, and these warnings land in
   * local logs. The pattern as written identifies the offending Include line just as well.
   */
  redactedLabel: string | null
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
    globProofs: createGlobReadabilityProofs(),
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

function markIncomplete(context: IncludeExpansionContext, target: string, detail?: string): void {
  context.fullyExpanded = false
  const because = detail ? ` (${detail})` : ''
  console.warn(
    `[ssh] Could not expand SSH config Include "${target}"${because}; hosts may be missing`
  )
}

/** An unreadable directory is the user's to fix; an unproven one is only bigger than our budget. */
function describeGlobUncertainty(
  uncertainty: GlobExpansionUncertainty,
  redactedLabel: string | null
): string {
  const where = redactedLabel === null ? `"${uncertainty.target}"` : 'a directory it matches'
  return uncertainty.reason === 'unreadable'
    ? `could not enumerate ${where}`
    : `${where} is too large to scan for completeness`
}

/**
 * `logTarget` is what warnings about this file name; it differs from `filePath` only when the path
 * came out of `${VAR}` expansion and so must not reach a log.
 */
function expandSshConfigFile(
  filePath: string,
  context: IncludeExpansionContext,
  activeStack: string[],
  logTarget: string = filePath
): string[] {
  const canonicalPath = getCanonicalPath(filePath, context, logTarget)
  if (!canonicalPath || activeStack.includes(canonicalPath)) {
    return []
  }

  const rawContent = readCachedFile(canonicalPath, context, logTarget)
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
      const resolved = resolveIncludePaths(includeArg, context)
      for (const matchedPath of resolved.paths) {
        appendExpandedLines(
          expandedLines,
          expandSshConfigFile(
            matchedPath,
            context,
            nextStack,
            resolved.redactedLabel ?? matchedPath
          )
        )
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

function readCachedFile(
  filePath: string,
  context: IncludeExpansionContext,
  logTarget: string
): string | null {
  const cached = context.cache.get(filePath)
  if (cached !== undefined) {
    return cached
  }

  if (!isReadableRegularFile(filePath, context, logTarget)) {
    return null
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    context.cache.set(filePath, content)
    return content
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, logTarget)
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

function resolveIncludePaths(
  pattern: string,
  context: IncludeExpansionContext
): ResolvedIncludePaths {
  const withEnv = expandEnvironmentVariables(pattern)
  if (withEnv === null) {
    markIncomplete(context, pattern, 'unset environment variable')
    return { paths: [], redactedLabel: pattern }
  }

  // Only a substitution that actually fired can carry a secret into a resolved path.
  const redactedLabel = withEnv === pattern ? null : pattern
  const logTarget = (resolved: string): string => redactedLabel ?? resolved

  const withTokens = expandIncludeTokens(withEnv, context)
  if (withTokens === null) {
    markIncomplete(context, pattern, 'token needs a connection target')
    return { paths: [], redactedLabel }
  }

  const absolutePattern = resolveIncludePatternPath(withTokens, context)
  if (hasGlobPattern(absolutePattern)) {
    try {
      const matches = globSync(absolutePattern).sort((left, right) => left.localeCompare(right))
      if (matches.length > MAX_INCLUDE_GLOB_MATCHES) {
        console.warn(
          `[ssh] Include pattern "${logTarget(absolutePattern)}" matched ${matches.length} files; processing first ${MAX_INCLUDE_GLOB_MATCHES}`
        )
        context.fullyExpanded = false
        return {
          paths: matches.slice(0, MAX_INCLUDE_GLOB_MATCHES),
          redactedLabel
        }
      }
      // Unconditional, not only on an empty result: a partial expansion is exactly as unproven, and
      // it is the half that goes on to feed a confident alias claim.
      const uncertainty = findGlobExpansionUncertainty(absolutePattern, context.pathApi, {
        proofs: context.globProofs
      })
      if (uncertainty) {
        markIncomplete(
          context,
          logTarget(absolutePattern),
          describeGlobUncertainty(uncertainty, redactedLabel)
        )
      }
      return { paths: matches, redactedLabel }
    } catch {
      // A glob that threw walked a directory it could not read; it never proved the set is empty.
      markIncomplete(context, logTarget(absolutePattern), 'glob traversal failed')
      return { paths: [], redactedLabel }
    }
  }

  // Not existsSync: it answers false for a path it merely could not stat, which would drop an
  // Include living behind an unreadable parent directory as if the user had never written it.
  try {
    statSync(absolutePattern)
    return { paths: [absolutePattern], redactedLabel }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, logTarget(absolutePattern))
    }
    return { paths: [], redactedLabel }
  }
}

function getCanonicalPath(
  filePath: string,
  context: IncludeExpansionContext,
  logTarget: string
): string | null {
  try {
    return realpathSync.native(filePath)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, logTarget)
    }
    return null
  }
}

function isReadableRegularFile(
  filePath: string,
  context: IncludeExpansionContext,
  logTarget: string
): boolean {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      console.warn(`[ssh] Skipping SSH config include "${logTarget}": not a regular file`)
      return false
    }
    if (stats.size > MAX_INCLUDE_FILE_BYTES) {
      console.warn(
        `[ssh] Skipping SSH config include "${logTarget}": size ${stats.size} exceeds ${MAX_INCLUDE_FILE_BYTES} bytes`
      )
      context.fullyExpanded = false
      return false
    }
    return true
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      markIncomplete(context, logTarget)
    }
    return false
  }
}

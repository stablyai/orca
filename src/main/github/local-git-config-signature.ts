import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { GitHubRepoContext } from './github-repository-identity'

type LocalGitConfigPaths = {
  commonConfigPath: string
  worktreeConfigPath: string
}

const localGitConfigSignatureInFlight = new Map<string, Promise<string | undefined>>()

export async function readLocalGitConfigSignature(
  context: GitHubRepoContext
): Promise<string | undefined> {
  if (context.connectionId || context.wslDistro) {
    // Why: this signature only covers host filesystem config files; remote
    // runtimes are already separated by cache key and probed through git.
    return undefined
  }
  const cacheKey = context.repoPath
  const inFlight = localGitConfigSignatureInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const read = readUncachedLocalGitConfigSignature(context.repoPath)
  localGitConfigSignatureInFlight.set(cacheKey, read)
  try {
    return await read
  } finally {
    if (localGitConfigSignatureInFlight.get(cacheKey) === read) {
      localGitConfigSignatureInFlight.delete(cacheKey)
    }
  }
}

export function __resetLocalGitConfigSignatureCacheForTests(): void {
  localGitConfigSignatureInFlight.clear()
}

async function readUncachedLocalGitConfigSignature(repoPath: string): Promise<string | undefined> {
  const configPaths = await resolveLocalGitConfigPaths(repoPath)
  if (!configPaths) {
    return undefined
  }
  const signatures = await Promise.all([
    readConfigPathSignatures(configPaths.commonConfigPath),
    readConfigPathSignatures(configPaths.worktreeConfigPath)
  ])
  return signatures.flat().join('\0')
}

async function readConfigPathSignatures(
  configPath: string,
  visited = new Set<string>()
): Promise<string[]> {
  if (visited.has(configPath)) {
    return []
  }
  visited.add(configPath)

  const ownSignature = await readConfigPathSignature(configPath)
  let configText: string
  try {
    configText = await readFile(configPath, 'utf8')
  } catch {
    return [ownSignature]
  }

  const includedPaths = parseIncludedConfigPaths(configText, dirname(configPath))
  const includedSignatures = await Promise.all(
    includedPaths.map((includedPath) => readConfigPathSignatures(includedPath, visited))
  )
  return [ownSignature, ...includedSignatures.flat()]
}

async function readConfigPathSignature(configPath: string): Promise<string> {
  try {
    const stats = await stat(configPath)
    return `${configPath}\0${stats.mtimeMs}\0${stats.size}`
  } catch {
    return `${configPath}\0missing`
  }
}

function parseIncludedConfigPaths(configText: string, baseDir: string): string[] {
  const includedPaths: string[] = []
  let inIncludeSection = false
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    const sectionName = parseConfigSectionName(line)
    if (sectionName) {
      inIncludeSection = sectionName === 'include' || sectionName.startsWith('includeif ')
      continue
    }
    if (!inIncludeSection) {
      continue
    }
    const includePath = parseIncludedConfigPath(line)
    if (includePath) {
      includedPaths.push(resolveIncludedConfigPath(includePath, baseDir))
    }
  }
  return includedPaths
}

function parseConfigSectionName(line: string): string | null {
  if (!line.startsWith('[')) {
    return null
  }
  let quote: string | null = null
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char !== ']') {
      continue
    }
    const trailing = line.slice(index + 1).trim()
    if (trailing && !trailing.startsWith('#') && !trailing.startsWith(';')) {
      return null
    }
    return line.slice(1, index).trim().toLowerCase()
  }
  return null
}

function parseIncludedConfigPath(line: string): string | null {
  const match = line.match(/^path\s*=\s*(.+)$/i)
  if (!match) {
    return null
  }
  const rawValue = match[1].trim()
  if (!rawValue) {
    return null
  }
  const quotedValue = parseQuotedConfigValue(rawValue)
  if (quotedValue !== null) {
    return quotedValue
  }
  const value = stripInlineConfigComment(rawValue).trim()
  if (!value) {
    return null
  }
  return value
}

function parseQuotedConfigValue(rawValue: string): string | null {
  const quote = rawValue[0]
  if (quote !== '"' && quote !== "'") {
    return null
  }
  const endQuoteIndex = rawValue.indexOf(quote, 1)
  if (endQuoteIndex === -1) {
    return null
  }
  const trailing = rawValue.slice(endQuoteIndex + 1).trim()
  if (trailing && !trailing.startsWith('#') && !trailing.startsWith(';')) {
    return null
  }
  return rawValue.slice(1, endQuoteIndex)
}

function stripInlineConfigComment(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value.replace(/\s[#;].*$/, '').trim()
}

function resolveIncludedConfigPath(includePath: string, baseDir: string): string {
  if (includePath === '~') {
    return homedir()
  }
  if (includePath.startsWith('~/')) {
    return join(homedir(), includePath.slice(2))
  }
  if (isAbsolute(includePath)) {
    return includePath
  }
  return resolve(baseDir, includePath)
}

async function resolveLocalGitConfigPaths(repoPath: string): Promise<LocalGitConfigPaths | null> {
  const dotGitPath = join(repoPath, '.git')
  try {
    const dotGitStats = await stat(dotGitPath)
    if (dotGitStats.isDirectory()) {
      return {
        commonConfigPath: join(dotGitPath, 'config'),
        worktreeConfigPath: join(dotGitPath, 'config.worktree')
      }
    }
    if (!dotGitStats.isFile()) {
      return null
    }
  } catch {
    return null
  }

  try {
    const gitFile = await readFile(dotGitPath, 'utf8')
    const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/im)
    if (!match) {
      return null
    }
    const gitDir = resolve(dirname(dotGitPath), match[1])
    let commonGitDir = gitDir
    try {
      const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
      if (commonDir) {
        commonGitDir = resolve(gitDir, commonDir)
      }
    } catch {
      // Fall back to the linked worktree gitdir below.
    }
    return {
      commonConfigPath: join(commonGitDir, 'config'),
      worktreeConfigPath: join(gitDir, 'config.worktree')
    }
  } catch {
    return null
  }
}

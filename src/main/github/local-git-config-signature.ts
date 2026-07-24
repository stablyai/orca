import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import type { GitHubRepoContext } from './github-repository-identity'
import { cacheIdentityDigest } from '../cache-identity-digest'

type LocalGitConfigPaths = {
  commonConfigPath: string
  worktreeConfigPath: string
}

const localGitConfigSignatureInFlight = new Map<string, Promise<string | undefined>>()
const LOCAL_GIT_CONFIG_SIGNATURE_MAX_IN_FLIGHT = 32
const MAX_GIT_CONFIG_BYTES = 4 * 1024 * 1024
const MAX_GIT_POINTER_FILE_BYTES = 64 * 1024
const MAX_INCLUDED_CONFIG_FILES = 256
const MAX_INCLUDED_CONFIG_DEPTH = 8
const MAX_INCLUDED_CONFIG_PATH_BYTES = 16 * 1024
const MAX_INCLUDED_CONFIG_AGGREGATE_PATH_BYTES = 2 * 1024 * 1024

type ConfigSignatureBudget = {
  admittedFiles: number
  pathBytes: number
}

export async function readLocalGitConfigSignature(
  context: GitHubRepoContext
): Promise<string | undefined> {
  if (context.connectionId || context.wslDistro) {
    // Why: this signature only covers host filesystem config files; remote
    // runtimes are already separated by cache key and probed through git.
    return undefined
  }
  const cacheKey = cacheIdentityDigest([context.repoPath])
  const inFlight = localGitConfigSignatureInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const read = readUncachedLocalGitConfigSignature(context.repoPath)
  if (localGitConfigSignatureInFlight.size >= LOCAL_GIT_CONFIG_SIGNATURE_MAX_IN_FLIGHT) {
    return read
  }
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
  const digest = createHash('sha256')
  for (const signature of signatures.flat()) {
    digest.update(`${signature.length}:`)
    digest.update(signature)
  }
  return digest.digest('base64url')
}

async function readConfigPathSignatures(
  configPath: string,
  visited = new Set<string>(),
  budget: ConfigSignatureBudget = { admittedFiles: 0, pathBytes: 0 },
  depth = 0
): Promise<string[]> {
  if (visited.has(configPath)) {
    return []
  }
  const measuredPath = measureUtf8ByteLength(configPath, {
    stopAfterBytes: MAX_INCLUDED_CONFIG_PATH_BYTES
  })
  if (
    measuredPath.exceededLimit ||
    depth > MAX_INCLUDED_CONFIG_DEPTH ||
    budget.admittedFiles >= MAX_INCLUDED_CONFIG_FILES ||
    budget.pathBytes + measuredPath.byteLength > MAX_INCLUDED_CONFIG_AGGREGATE_PATH_BYTES
  ) {
    return []
  }
  visited.add(configPath)
  budget.admittedFiles += 1
  budget.pathBytes += measuredPath.byteLength

  const ownSignature = await readConfigPathSignature(configPath)
  let configText: string
  try {
    configText = (await readNodeFileWithinLimit(configPath, MAX_GIT_CONFIG_BYTES)).buffer.toString(
      'utf8'
    )
  } catch {
    return [ownSignature]
  }

  const includedPaths = parseIncludedConfigPaths(configText, dirname(configPath))
  const signatures = [ownSignature]
  for (const includedPath of includedPaths) {
    signatures.push(...(await readConfigPathSignatures(includedPath, visited, budget, depth + 1)))
  }
  return signatures
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
      if (includedPaths.length >= MAX_INCLUDED_CONFIG_FILES) {
        break
      }
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
    const gitFile = (
      await readNodeFileWithinLimit(dotGitPath, MAX_GIT_POINTER_FILE_BYTES)
    ).buffer.toString('utf8')
    const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/im)
    if (!match) {
      return null
    }
    const gitDir = resolve(dirname(dotGitPath), match[1])
    let commonGitDir = gitDir
    try {
      const commonDir = (
        await readNodeFileWithinLimit(join(gitDir, 'commondir'), MAX_GIT_POINTER_FILE_BYTES)
      ).buffer
        .toString('utf8')
        .trim()
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

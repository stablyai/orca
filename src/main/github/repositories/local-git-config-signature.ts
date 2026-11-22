import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCoalescedProbe, type CoalescedProbes } from '../../git/remotes/coalesced-probe'
import type { GitHubRepoContext } from './github-repository-identity'

type LocalGitConfigPaths = {
  commonConfigPath: string
  worktreeConfigPath: string
  headPath: string
}

// A dead mount can stall stat before the bounded Git probe; missing signatures use shorter cache lifetimes.
const CONFIG_SIGNATURE_DEADLINE_MS = 2_000

const localGitConfigSignatureInFlight: CoalescedProbes<string | undefined> = new Map()

export async function readLocalGitConfigSignature(
  context: GitHubRepoContext
): Promise<string | undefined> {
  if (context.connectionId || context.wslDistro) {
    // Remote runtimes have separate cache keys; this signature covers host filesystem config only.
    return undefined
  }
  // Deadline only the caller: keep the in-flight read shared so a hung mount cannot accumulate more reads.
  return withConfigSignatureDeadline(
    runCoalescedProbe(localGitConfigSignatureInFlight, context.repoPath, () =>
      readUncachedLocalGitConfigSignature(context.repoPath)
    )
  )
}

function withConfigSignatureDeadline(
  read: Promise<string | undefined>
): Promise<string | undefined> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(undefined), CONFIG_SIGNATURE_DEADLINE_MS)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    void read.then(
      (signature) => {
        clearTimeout(timer)
        settle(signature)
      },
      () => {
        clearTimeout(timer)
        settle(undefined)
      }
    )
  })
}

async function readUncachedLocalGitConfigSignature(repoPath: string): Promise<string | undefined> {
  const configPaths = await resolveLocalGitConfigPaths(repoPath)
  if (!configPaths) {
    return undefined
  }
  let branchRead: Promise<string> | undefined
  const readBranch = (): Promise<string> => {
    branchRead ??= readBranchSignature(configPaths.headPath)
    return branchRead
  }
  const signatures = await Promise.all([
    readConfigPathSignatures(configPaths.commonConfigPath, readBranch),
    readConfigPathSignatures(configPaths.worktreeConfigPath, readBranch)
  ])
  // Includes are walked concurrently, so a shared include lands under whichever parent reaches it first.
  return signatures.flat().sort().join('\0')
}

async function readConfigPathSignatures(
  configPath: string,
  readBranch: () => Promise<string>,
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

  const { paths: includedPaths, onBranch } = parseIncludedConfigPaths(
    configText,
    dirname(configPath)
  )
  const includedSignatures = await Promise.all(
    includedPaths.map((includedPath) => readConfigPathSignatures(includedPath, readBranch, visited))
  )
  // HEAD contents distinguish branch switches even on filesystems with coarse timestamps.
  const branchSignature = onBranch ? [await readBranch()] : []
  return [ownSignature, ...branchSignature, ...includedSignatures.flat()]
}

async function readBranchSignature(headPath: string): Promise<string> {
  const head = await readFile(headPath, 'utf8')
  if (head.trim() === 'ref: refs/heads/.invalid') {
    throw new Error('Branch-dependent reftable config cannot be signed from loose HEAD')
  }
  // onbranch never matches detached HEAD, so commits there do not change effective config.
  return head.startsWith('ref:') ? head : 'detached'
}

async function readConfigPathSignature(configPath: string): Promise<string> {
  try {
    const stats = await stat(configPath)
    return `${configPath}\0${stats.mtimeMs}\0${stats.size}`
  } catch {
    return `${configPath}\0missing`
  }
}

function parseIncludedConfigPaths(
  configText: string,
  baseDir: string
): { paths: string[]; onBranch: boolean } {
  const includedPaths: string[] = []
  let inIncludeSection = false
  let onBranch = false
  for (const rawLine of configText.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    const section = parseConfigSection(line)
    if (section) {
      inIncludeSection = section.name === 'include' || /^includeif\s/.test(section.name)
      onBranch ||= /^includeif\s+"onbranch:/.test(section.name)
      line = section.rest
    }
    if (!inIncludeSection) {
      continue
    }
    const includePath = parseIncludedConfigPath(line)
    if (includePath) {
      includedPaths.push(resolveIncludedConfigPath(includePath, baseDir))
    }
  }
  return { paths: includedPaths, onBranch }
}

function parseConfigSection(line: string): { name: string; rest: string } | null {
  if (!line.startsWith('[')) {
    return null
  }
  let quote: string | null = null
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\') {
        index += 1
        continue
      }
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
    return {
      name: line.slice(1, index).replace(/\\(.)/g, '$1').trim().toLowerCase(),
      rest: line.slice(index + 1).trim()
    }
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
        worktreeConfigPath: join(dotGitPath, 'config.worktree'),
        headPath: join(dotGitPath, 'HEAD')
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
      // Try the linked-worktree gitdir instead.
    }
    return {
      commonConfigPath: join(commonGitDir, 'config'),
      worktreeConfigPath: join(gitDir, 'config.worktree'),
      headPath: join(gitDir, 'HEAD')
    }
  } catch {
    return null
  }
}

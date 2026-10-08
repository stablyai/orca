import { statSync } from 'node:fs'
import path from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { quotePosixShell } from '../shared/wsl-login-shell-command'

export type ArchiveHookShell = 'posix' | 'cmd'

export type ArchiveHookPathLookup = {
  /** Checkout that supplied the archive command (`orca.yaml`'s directory). */
  yamlRoot: string
  /** Directory the hook process keeps as cwd. The worktree being removed. */
  cwd: string
  shell: ArchiveHookShell
  isFile(absolutePath: string): boolean
}

type Word = { start: number; end: number; text: string; unsafe: boolean }

type Hit = { start: number; end: number; yamlAbs: string; cwdAbs: string }

function pathApi(root: string): path.PlatformPath {
  return isWindowsAbsolutePathLike(root) ? path.win32 : path.posix
}

function quoteForShell(value: string, shell: ArchiveHookShell): string {
  if (shell === 'cmd') {
    return `"${value.replace(/"/g, '""')}"`
  }
  return quotePosixShell(value)
}

function isCandidate(text: string, api: path.PlatformPath): boolean {
  if (!text || text.startsWith('-') || text.includes('=') || text.includes(':')) {
    return false
  }
  if (text.includes('<') || text.includes('>')) {
    return false
  }
  if (api.isAbsolute(text)) {
    return false
  }
  return text.includes('/') || text.includes('\\') || text.startsWith('.')
}

function staysInside(root: string, absolute: string, api: path.PlatformPath): boolean {
  const relative = api.relative(root, absolute)
  return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative)
}

/** POSIX heredoc opener. The body is the worktree's data, not a path to retarget. */
function heredocDelimiter(line: string): string | null {
  const match = line.match(/<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

function scanWords(line: string, shell: ArchiveHookShell): Word[] {
  const words: Word[] = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index])) {
      index += 1
    }
    if (index >= line.length) {
      break
    }
    if (shell === 'posix' && line[index] === '#') {
      break
    }
    const start = index
    let text = ''
    let unsafe = false
    let quote: '"' | "'" | null = null
    while (index < line.length) {
      const char = line[index]
      if (quote === "'") {
        if (char === "'") {
          quote = null
          index += 1
          continue
        }
        text += char
        index += 1
        continue
      }
      if (quote === '"') {
        if (char === '\\' && index + 1 < line.length) {
          const next = line[index + 1]
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            if (next === '$' || next === '`') {
              unsafe = true
            }
            text += next
            index += 2
            continue
          }
        }
        if (char === '"') {
          quote = null
          index += 1
          continue
        }
        if (char === '$' || char === '`') {
          unsafe = true
        }
        text += char
        index += 1
        continue
      }
      if (shell === 'posix' && char === '\\' && index + 1 < line.length) {
        text += line[index + 1]
        index += 2
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        index += 1
        continue
      }
      if (/\s/.test(char)) {
        break
      }
      if (
        char === '$' ||
        char === '`' ||
        char === '*' ||
        char === '?' ||
        char === '[' ||
        char === '~'
      ) {
        unsafe = true
      }
      text += char
      index += 1
    }
    if (quote) {
      unsafe = true
    }
    words.push({ start, end: index, text, unsafe })
  }
  return words
}

function hitsOnLine(
  line: string,
  lookup: Omit<ArchiveHookPathLookup, 'isFile'>,
  api: path.PlatformPath
): Hit[] {
  const hits: Hit[] = []
  for (const word of scanWords(line, lookup.shell)) {
    if (word.unsafe || !isCandidate(word.text, api)) {
      continue
    }
    const yamlAbs = api.resolve(lookup.yamlRoot, word.text)
    if (!staysInside(lookup.yamlRoot, yamlAbs, api)) {
      continue
    }
    hits.push({
      start: word.start,
      end: word.end,
      yamlAbs,
      cwdAbs: api.resolve(lookup.cwd, word.text)
    })
  }
  return hits
}

function rewriteLine(line: string, lookup: ArchiveHookPathLookup, api: path.PlatformPath): string {
  const hits = hitsOnLine(line, lookup, api).filter(
    (hit) => lookup.isFile(hit.yamlAbs) && !lookup.isFile(hit.cwdAbs)
  )
  let next = line
  for (const hit of hits.sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, hit.start)}${quoteForShell(hit.yamlAbs, lookup.shell)}${next.slice(hit.end)}`
  }
  return next
}

function samePlace(yamlRoot: string, cwd: string, api: path.PlatformPath): boolean {
  return api.resolve(yamlRoot) === api.resolve(cwd)
}

function walkLines(
  script: string,
  lookup: Omit<ArchiveHookPathLookup, 'isFile'>,
  onLine: (line: string, api: path.PlatformPath) => string
): string {
  const api = pathApi(lookup.yamlRoot)
  if (samePlace(lookup.yamlRoot, lookup.cwd, api)) {
    return script
  }
  let heredoc: string | null = null
  return script
    .split('\n')
    .map((rawLine) => {
      const cr = rawLine.endsWith('\r')
      const line = cr ? rawLine.slice(0, -1) : rawLine
      if (heredoc) {
        if (line === heredoc) {
          heredoc = null
        }
        return rawLine
      }
      const rewritten = onLine(line, api)
      if (lookup.shell === 'posix') {
        heredoc = heredocDelimiter(line)
      }
      return cr ? `${rewritten}\r` : rewritten
    })
    .join('\n')
}

/** Absolute paths a remote stat must answer before {@link resolveArchiveHookCommandPaths}. */
export function archiveHookPathProbeTargets(
  script: string,
  lookup: Omit<ArchiveHookPathLookup, 'isFile'>
): string[] {
  const targets: string[] = []
  walkLines(script, lookup, (line, api) => {
    for (const hit of hitsOnLine(line, lookup, api)) {
      targets.push(hit.yamlAbs, hit.cwdAbs)
    }
    return line
  })
  return targets
}

/**
 * Point relative archive-script paths at the checkout that supplied `orca.yaml` when the
 * worktree being removed does not have that file. cwd stays the worktree. A copy in the
 * worktree wins, and setup commands never come through here.
 */
export function resolveArchiveHookCommandPaths(
  script: string,
  lookup: ArchiveHookPathLookup
): string {
  return walkLines(script, lookup, (line, api) => rewriteLine(line, lookup, api))
}

export async function resolveArchiveHookCommandPathsWhere(
  script: string,
  lookup: Omit<ArchiveHookPathLookup, 'isFile'>,
  isFile: (absolutePath: string) => Promise<boolean>
): Promise<string> {
  const present = new Set<string>()
  for (const target of archiveHookPathProbeTargets(script, lookup)) {
    if (!present.has(target) && (await isFile(target))) {
      present.add(target)
    }
  }
  return resolveArchiveHookCommandPaths(script, {
    ...lookup,
    isFile: (absolutePath) => present.has(absolutePath)
  })
}

function shellPathOnHost(
  shellAbsolute: string,
  hostYamlRoot: string,
  shellYamlRoot: string
): string {
  if (hostYamlRoot === shellYamlRoot) {
    return shellAbsolute
  }
  const relative = path.posix.relative(shellYamlRoot, shellAbsolute)
  if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
    return shellAbsolute
  }
  const host = isWindowsAbsolutePathLike(hostYamlRoot) ? path.win32 : path.posix
  return host.resolve(hostYamlRoot, ...relative.split('/'))
}

/** `isFile` for a hook shell. WSL embeds Linux paths; the stat still uses the host checkout. */
export function archiveHookPathIsFile(
  shellAbsolute: string,
  hostYamlRoot: string,
  shellYamlRoot: string
): boolean {
  try {
    return statSync(shellPathOnHost(shellAbsolute, hostYamlRoot, shellYamlRoot)).isFile()
  } catch {
    return false
  }
}

export function resolveArchiveHookCommandForRun(args: {
  script: string
  hookName: 'setup' | 'archive'
  hostYamlRoot: string
  shellYamlRoot: string
  shellCwd: string
  shell: ArchiveHookShell
}): string {
  if (args.hookName !== 'archive') {
    return args.script
  }
  return resolveArchiveHookCommandPaths(args.script, {
    yamlRoot: args.shellYamlRoot,
    cwd: args.shellCwd,
    shell: args.shell,
    isFile: (absolute) => archiveHookPathIsFile(absolute, args.hostYamlRoot, args.shellYamlRoot)
  })
}

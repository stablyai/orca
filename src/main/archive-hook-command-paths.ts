import { statSync } from 'node:fs'
import path from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { parseWslUncPath, toWindowsWslDrivePath, toWindowsWslUncPath } from '../shared/wsl-paths'
import {
  archiveHookHeredocClosed,
  archiveHookHeredocDelimiter,
  archiveHookRedirectsNextWord,
  quoteArchiveHookShell,
  scanArchiveHookWords,
  type ArchiveHookShell,
  type ArchiveHookWord
} from './archive-hook-shell-lex'

export type { ArchiveHookShell }

export type ArchiveHookPathLookup = {
  /** Checkout that supplied the archive command (`orca.yaml`'s directory). */
  yamlRoot: string
  /** Directory the hook process keeps as cwd. The worktree being removed. */
  cwd: string
  shell: ArchiveHookShell
  isFile(absolutePath: string): boolean
}

type Hit = { start: number; end: number; yamlAbs: string; cwdAbs: string }

function pathApi(root: string): path.PlatformPath {
  return isWindowsAbsolutePathLike(root) ? path.win32 : path.posix
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

const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'node',
  'python',
  'python3',
  'pwsh',
  'powershell'
])
// Words glued to an operator (`a.sh;`) are not split, so they are never rewritten.
const POSIX_SEPARATORS = new Set([';', '&&', '||', '|', '&', '('])
// cmd.exe treats `;` as an argument delimiter, not a command separator.
const CMD_SEPARATORS = new Set(['&&', '||', '|', '&', '('])

type WordRole = 'command' | 'interpreter-operand' | 'option-value' | 'script-operand' | 'argument'
type ScanState = { role: WordRole; interpreter: string; redirectOperand: boolean }

const FRESH_COMMAND: ScanState = { role: 'command', interpreter: '', redirectOperand: false }

function interpreterName(word: string, api: path.PlatformPath): string {
  return api
    .basename(word)
    .toLowerCase()
    .replace(/\.exe$/, '')
}

/** After this option the interpreter runs stdin or inline code, so later words are data. */
function readsInlineCode(interpreter: string, option: string): boolean {
  if (option === '-') {
    return true
  }
  if (interpreter === 'node') {
    return option === '-e' || option === '-p' || /^--(?:eval|print)(?:=|$)/.test(option)
  }
  if (interpreter.startsWith('python')) {
    return /^-[A-Za-z]*[cm]/.test(option)
  }
  return /^-[A-Za-z]*[cs]/.test(option)
}

type PwshSwitch = readonly [name: string, shortest: string]
// pwsh accepts any prefix of a switch at least as long as its shortest unambiguous form.
const PWSH_INLINE_CODE: PwshSwitch[] = [
  ['command', 'c'],
  ['encodedcommand', 'e'],
  ['ec', 'ec'],
  ['commandwithargs', 'commandwithargs'],
  ['cwa', 'cwa']
]
const PWSH_FILE: PwshSwitch[] = [['file', 'f']]
const PWSH_VALUE_OPTIONS: PwshSwitch[] = [
  ['executionpolicy', 'ex'],
  ['ep', 'ep'],
  ['workingdirectory', 'wo'],
  ['wd', 'wd'],
  ['configurationname', 'config'],
  ['configurationfile', 'configurationfile'],
  ['psconsolefile', 'psconsolefile'],
  ['version', 'v'],
  ['settingsfile', 'settings'],
  ['outputformat', 'o'],
  ['of', 'of'],
  ['inputformat', 'inp'],
  ['if', 'if'],
  ['windowstyle', 'w'],
  ['custompipename', 'cus']
]

function matchesPwshSwitch(option: string, switches: PwshSwitch[]): boolean {
  const key = option.replace(/^--?/, '').toLowerCase()
  return switches.some(([name, shortest]) => key.length >= shortest.length && name.startsWith(key))
}

function roleAfterOption(interpreter: string, option: string): WordRole {
  if (interpreter !== 'pwsh' && interpreter !== 'powershell') {
    return readsInlineCode(interpreter, option) ? 'argument' : 'interpreter-operand'
  }
  if (option === '-' || matchesPwshSwitch(option, PWSH_INLINE_CODE)) {
    return 'argument'
  }
  if (matchesPwshSwitch(option, PWSH_FILE)) {
    return 'script-operand'
  }
  return matchesPwshSwitch(option, PWSH_VALUE_OPTIONS) ? 'option-value' : 'interpreter-operand'
}

function hitFor(
  word: ArchiveHookWord,
  lookup: Omit<ArchiveHookPathLookup, 'isFile'>,
  api: path.PlatformPath
): Hit | null {
  if (word.unsafe || !isCandidate(word.text, api)) {
    return null
  }
  const yamlAbs = api.resolve(lookup.yamlRoot, word.text)
  if (!staysInside(lookup.yamlRoot, yamlAbs, api)) {
    return null
  }
  return { start: word.start, end: word.end, yamlAbs, cwdAbs: api.resolve(lookup.cwd, word.text) }
}

/** Only a command word and an interpreter's first script operand; other arguments may be data. */
function hitsOnLine(
  line: string,
  lookup: Omit<ArchiveHookPathLookup, 'isFile'>,
  api: path.PlatformPath,
  start: ScanState
): { hits: Hit[]; state: ScanState; continues: boolean } {
  const hits: Hit[] = []
  const separators = lookup.shell === 'cmd' ? CMD_SEPARATORS : POSIX_SEPARATORS
  let { role, interpreter, redirectOperand } = start
  let continues = false
  for (const word of scanArchiveHookWords(line, lookup.shell)) {
    const raw = line.slice(word.start, word.end)
    // Comments are never scanned, so a backslash there does not continue the line.
    continues = lookup.shell === 'posix' && /(?:^|[^\\])(?:\\\\)*\\$/.test(raw)
    if (continues && raw === '\\') {
      continue
    }
    if (redirectOperand) {
      redirectOperand = false
      continue
    }
    if (separators.has(raw)) {
      role = 'command'
      continue
    }
    redirectOperand = archiveHookRedirectsNextWord(raw)
    if (redirectOperand && /^[\d<>&|-]+$/.test(raw)) {
      continue
    }
    if (role === 'command') {
      if (lookup.shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
        continue
      }
      interpreter = interpreterName(word.text, api)
      const runsScript =
        INTERPRETERS.has(interpreter) || (lookup.shell === 'cmd' && interpreter === 'call')
      role = runsScript ? 'interpreter-operand' : 'argument'
    } else if (role === 'interpreter-operand') {
      if (word.text.startsWith('-')) {
        role = roleAfterOption(interpreter, word.text)
        continue
      }
      role = 'argument'
    } else if (role === 'option-value') {
      role = 'interpreter-operand'
      continue
    } else if (role === 'script-operand') {
      role = 'argument'
    } else {
      continue
    }
    const hit = hitFor(word, lookup, api)
    if (hit) {
      hits.push(hit)
    }
  }
  return { hits, state: { role, interpreter, redirectOperand }, continues }
}

function rewriteLine(
  line: string,
  lookup: ArchiveHookPathLookup,
  api: path.PlatformPath,
  state: ScanState
): { line: string; state: ScanState; continues: boolean } {
  const scan = hitsOnLine(line, lookup, api, state)
  const hits = scan.hits.filter((hit) => lookup.isFile(hit.yamlAbs) && !lookup.isFile(hit.cwdAbs))
  let next = line
  for (const hit of hits.sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, hit.start)}${quoteArchiveHookShell(hit.yamlAbs, lookup.shell)}${next.slice(hit.end)}`
  }
  return { line: next, state: scan.state, continues: scan.continues }
}

function samePlace(yamlRoot: string, cwd: string, api: path.PlatformPath): boolean {
  return api.resolve(yamlRoot) === api.resolve(cwd)
}

/**
 * Point a relative archive command word, or an interpreter's script operand, at the checkout
 * that supplied `orca.yaml` when the worktree being removed does not have that file. cwd stays
 * the worktree. A copy in the worktree wins, and setup commands never come through here.
 */
export function resolveArchiveHookCommandPaths(
  script: string,
  lookup: ArchiveHookPathLookup
): string {
  const api = pathApi(lookup.yamlRoot)
  if (samePlace(lookup.yamlRoot, lookup.cwd, api)) {
    return script
  }
  let heredoc: ReturnType<typeof archiveHookHeredocDelimiter> = null
  let state = FRESH_COMMAND
  return script
    .split('\n')
    .map((rawLine) => {
      const cr = rawLine.endsWith('\r')
      const line = cr ? rawLine.slice(0, -1) : rawLine
      if (heredoc) {
        if (archiveHookHeredocClosed(line, heredoc)) {
          heredoc = null
        }
        return rawLine
      }
      const rewritten = rewriteLine(line, lookup, api, state)
      // A trailing backslash continues the same command on the next line.
      state = rewritten.continues ? rewritten.state : FRESH_COMMAND
      if (lookup.shell === 'posix') {
        heredoc = archiveHookHeredocDelimiter(line)
      }
      return cr ? `${rewritten.line}\r` : rewritten.line
    })
    .join('\n')
}

/**
 * Windows cannot stat the Linux path the hook shell uses. A worktree sits beside the checkout
 * that supplied orca.yaml, so a relative join from that checkout starts with `..` and used to
 * leave the Linux path unmapped. Then the worktree's own script looked missing and lost to main.
 */
export function archiveHookShellPathOnHost(
  shellAbsolute: string,
  hostYamlRoot: string,
  shellYamlRoot: string
): string {
  if (hostYamlRoot === shellYamlRoot) {
    return shellAbsolute
  }
  const drivePath = toWindowsWslDrivePath(shellAbsolute)
  if (drivePath) {
    return drivePath
  }
  const hostWsl = parseWslUncPath(hostYamlRoot)
  if (hostWsl && shellAbsolute.startsWith('/') && !shellAbsolute.startsWith('//')) {
    return toWindowsWslUncPath(shellAbsolute, hostWsl.distro)
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
    return statSync(archiveHookShellPathOnHost(shellAbsolute, hostYamlRoot, shellYamlRoot)).isFile()
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

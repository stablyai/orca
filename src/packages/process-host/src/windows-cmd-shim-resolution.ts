// Resolve only exact known shims with verified targets; otherwise preserve cmd.exe fallback.
import { readFileSync, statSync, type Stats } from 'node:fs'
import { win32 } from 'node:path'

const DISABLE_FLAG = 'ORCA_DISABLE_CMD_SHIM_RESOLUTION'

// Bound reads of unrecognized or malformed shim files.
const MAX_SHIM_BYTES = 64 * 1024

// Both dp0 spellings end in a separator; tolerate a redundant trailing one.
const DP0 = String.raw`(?:%~dp0|%dp0%)\\?`
const DP0_NODE_EXE = `"${DP0}node\\.exe"`
const dp0Path = (group: string): string => `"${DP0}(?<${group}>[^"\\r\\n]+)"`

const ECHO_OFF = String.raw`@echo off\n`
const FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`
const NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`
const PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`

// Modern npm cmd-shim selects the interpreter through %_prog%.
const NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path('script')} +%\*$`,
  'i'
)

// Legacy npm and pnpm repeat the script in both interpreter branches.
const BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path('script')} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path('scriptElse')} +%\*\n\)$`,
  'i'
)

// npm shims for native executables need no interpreter.
const NPM_DIRECT_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path('target')} +%\*$`,
  'i'
)

// pnpm native-executable shims may omit echo-off.
const PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path('target')} +%\*$`, 'i')

// Reject drive-relative paths and alternate streams: isAbsolute alone permits D:evil.js and a.js:zone.
const UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/

// Extensionless and batch targets need cmd PATHEXT lookup, so cannot bypass cmd.exe.
const DIRECT_TARGET_EXTENSIONS = ['.exe', '.com']

export type ParsedWindowsCmdShim =
  | { kind: 'node'; script: string; nodePathPrefix?: string }
  | { kind: 'direct'; target: string }

function isPlainRelativePath(spelled: string): boolean {
  return !UNSAFE_SHIM_PATH.test(spelled) && !win32.isAbsolute(spelled)
}

function canonicalize(contents: string): string {
  return contents
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/** Returns paths as spelled in the shim, relative to its directory. */
export function parseWindowsCmdShim(contents: string): ParsedWindowsCmdShim | null {
  const canonical = canonicalize(contents)

  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups
  if (prog?.script) {
    return isPlainRelativePath(prog.script) ? { kind: 'node', script: prog.script } : null
  }

  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups
  if (branched?.script) {
    // Divergent branches are not a shim we can safely replace.
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) {
      return null
    }
    const nodePath = branched.nodePath
    if (nodePath === undefined) {
      return { kind: 'node', script: branched.script }
    }
    // Only reproduce an exact NODE_PATH prepend, without variable expansion.
    if (nodePath.includes('%') || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) {
      return null
    }
    return { kind: 'node', script: branched.script, nodePathPrefix: nodePath }
  }

  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target
    if (target) {
      return isPlainRelativePath(target) ? { kind: 'direct', target } : null
    }
  }
  return null
}

type ParseCacheEntry = {
  mtimeMs: number
  size: number
  parsed: ParsedWindowsCmdShim | null
}

// mtime and size invalidate parsed bodies after package upgrades.
const parseCache = new Map<string, ParseCacheEntry>()
const PARSE_CACHE_LIMIT = 256

// Cache interpreter lookup to avoid a synchronous PATH walk on every spawn.
const nodeCache = new Map<string, string | null>()
const NODE_CACHE_LIMIT = 256

function statFile(path: string): Stats | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

function readParsedShim(program: string): ParsedWindowsCmdShim | null {
  // A synchronous stat can block on network shares; interpreter probes run only for recognized shims.
  const stats = statFile(program)
  if (!stats || stats.size > MAX_SHIM_BYTES) {
    return null
  }
  const cached = parseCache.get(program)
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.parsed
  }
  let contents: string
  try {
    contents = readFileSync(program, 'utf8')
  } catch {
    return null
  }
  const parsed = parseWindowsCmdShim(contents)
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.clear()
  }
  parseCache.set(program, { mtimeMs: stats.mtimeMs, size: stats.size, parsed })
  return parsed
}

/** Win32 resolves environment names case-insensitively; a JS object does not. */
function firstEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== undefined)
}

// Preserve cmd PATHEXT order: node.com outranks node.exe.
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'

/** Prefer sibling node.exe, then cmd PATH/PATHEXT order; deliberately exclude cwd lookup. */
function resolveShimNode(directory: string, env: NodeJS.ProcessEnv): string | null {
  const pathKey = firstEnvKey(env, 'PATH')
  const pathValue = (pathKey ? env[pathKey] : undefined) ?? ''
  const pathExtKey = firstEnvKey(env, 'PATHEXT')
  const pathExtValue = (pathExtKey ? env[pathExtKey] : undefined) || DEFAULT_PATHEXT
  const key = `${directory}\n${pathValue}\n${pathExtValue}`
  const cached = nodeCache.get(key)
  // Revalidate cached paths after uninstall; cached null safely retains the cmd.exe fallback.
  if (cached !== undefined && (cached === null || statFile(cached))) {
    return cached
  }
  const resolved = probeShimNode(directory, pathValue, pathExtValue)
  if (nodeCache.size >= NODE_CACHE_LIMIT) {
    nodeCache.clear()
  }
  nodeCache.set(key, resolved)
  return resolved
}

function probeShimNode(directory: string, pathValue: string, pathExtValue: string): string | null {
  const sibling = win32.join(directory, 'node.exe')
  if (statFile(sibling)) {
    return sibling
  }
  const extensions = pathExtValue
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'))
  for (const entry of pathValue.split(';')) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, '$1')
    // Relative PATH entries depend on the child cwd, which is unknown here.
    if (!trimmed || !win32.isAbsolute(trimmed)) {
      continue
    }
    // Stop at any PATHEXT winner; skipping node.com for a later node.exe would run the wrong binary.
    for (const extension of extensions) {
      const candidate = win32.join(trimmed, `node${extension}`)
      if (!statFile(candidate)) {
        continue
      }
      return extension === '.exe' ? candidate : null
    }
  }
  return null
}

function withNodePath(env: NodeJS.ProcessEnv, prefix: string): NodeJS.ProcessEnv {
  const key = firstEnvKey(env, 'NODE_PATH') ?? 'NODE_PATH'
  const existing = env[key]
  // `IF NOT DEFINED` is false for an empty value too — cmd has no empty variables.
  return { ...env, [key]: existing ? `${prefix};${existing}` : prefix }
}

export type WindowsCmdShimResolution = {
  program: string
  prefixArgs: readonly string[]
  /** Set only when the shim itself mutates the environment (pnpm's NODE_PATH). */
  env?: NodeJS.ProcessEnv
}

/** Pass the actual child environment for PATH lookup and NODE_PATH prepending; null keeps cmd.exe. */
export function resolveWindowsCmdShim(
  program: string,
  env: NodeJS.ProcessEnv
): WindowsCmdShimResolution | null {
  const disableKey = firstEnvKey(env, DISABLE_FLAG)
  if (disableKey && env[disableKey]) {
    return null
  }
  // Relative programs depend on the child cwd, which is unknown here.
  if (!win32.isAbsolute(program)) {
    return null
  }
  const parsed = readParsedShim(program)
  if (!parsed) {
    return null
  }
  const directory = win32.dirname(program)

  if (parsed.kind === 'direct') {
    const target = win32.resolve(directory, parsed.target)
    const lower = target.toLowerCase()
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null
    }
    return statFile(target) ? { program: target, prefixArgs: [] } : null
  }

  const script = win32.resolve(directory, parsed.script)
  if (!statFile(script)) {
    return null
  }
  const node = resolveShimNode(directory, env)
  if (!node) {
    return null
  }
  return {
    program: node,
    prefixArgs: [script],
    ...(parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {})
  }
}

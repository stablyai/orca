import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

export type LaunchVariableContext = {
  worktreePath: string
  /** Absolute path of the file the user is on; every ${file...} variable needs it. */
  filePath?: string
  lineNumber?: number
  /** ${cwd}; defaults to the worktree. */
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** The execution host's platform, which picks the path flavour (an SSH host may differ from this one). */
  platform?: NodeJS.Platform
  /** Leaves ${env:NAME} as written, for display. */
  keepEnv?: boolean
}

export type LaunchVariableRefusal = {
  ok: false
  reason: 'unsupported-variable' | 'needs-file'
  /** Each offending `${...}` exactly as written, first-seen order. */
  variables: string[]
  message: string
}

export type LaunchConfigObject = Record<string, unknown>

export function isLaunchConfigObject(value: unknown): value is LaunchConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type LaunchVariableResult = { ok: true; value: LaunchConfigObject } | LaunchVariableRefusal

// Answered by a VS Code UI or settings store Orca has no equivalent of; expanding to '' would launch something else.
const UNSUPPORTED_PREFIXES = ['command:', 'input:', 'config:']

const FILE_VARIABLES = new Set([
  'file',
  'fileBasename',
  'fileBasenameNoExtension',
  'fileDirname',
  'fileExtname',
  'relativeFile',
  'relativeFileDirname',
  'lineNumber'
])

type Refusals = { unsupported: string[]; needsFile: string[] }

function relativeTo(path: typeof posix, base: string, target: string): string {
  const rel = path.relative(base, target)
  // Outside the worktree a ../ chain is worse than the absolute path.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return target
  }
  return rel === '' ? '.' : rel
}

/** The value of one known variable, or undefined when the name is not one Orca expands. */
function variableValue(name: string, ctx: LaunchVariableContext): string | undefined {
  const path = (ctx.platform ?? process.platform) === 'win32' ? win32 : posix
  if (name.startsWith('env:')) {
    return ctx.keepEnv ? `\${${name}}` : ((ctx.env ?? process.env)[name.slice('env:'.length)] ?? '')
  }
  const file = ctx.filePath ?? ''
  switch (name) {
    case 'workspaceFolder':
      return ctx.worktreePath
    case 'workspaceFolderBasename':
      return path.basename(ctx.worktreePath)
    case 'cwd':
      return ctx.cwd ?? ctx.worktreePath
    case 'pathSeparator':
      return path.sep
    case 'file':
      return file
    case 'fileBasename':
      return path.basename(file)
    case 'fileBasenameNoExtension':
      return path.basename(file, path.extname(file))
    case 'fileDirname':
      return path.dirname(file)
    case 'fileExtname':
      return path.extname(file)
    case 'relativeFile':
      return relativeTo(path, ctx.worktreePath, file)
    case 'relativeFileDirname':
      return relativeTo(path, ctx.worktreePath, path.dirname(file))
    case 'lineNumber':
      return String(ctx.lineNumber)
  }
  return undefined
}

function substituteString(text: string, ctx: LaunchVariableContext, refusals: Refusals): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('${', i)
    const end = start === -1 ? -1 : text.indexOf('}', start)
    // An unterminated ${ is literal text, not a variable.
    if (start === -1 || end === -1) {
      return out + text.slice(i)
    }
    out += text.slice(i, start)
    const token = text.slice(start, end + 1)
    const name = text.slice(start + 2, end)
    i = end + 1
    if (UNSUPPORTED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      refusals.unsupported.push(token)
      out += token
      continue
    }
    const missingInput =
      FILE_VARIABLES.has(name) &&
      (!ctx.filePath || (name === 'lineNumber' && ctx.lineNumber === undefined))
    if (missingInput) {
      refusals.needsFile.push(token)
      out += token
      continue
    }
    // Unknown names survive: delve and js-debug run their own substitution pass.
    out += variableValue(name, ctx) ?? token
  }
  return out
}

function substituteObject(
  value: LaunchConfigObject,
  ctx: LaunchVariableContext,
  refusals: Refusals
): LaunchConfigObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, substituteValue(item, ctx, refusals)])
  )
}

function substituteValue(value: unknown, ctx: LaunchVariableContext, refusals: Refusals): unknown {
  if (typeof value === 'string') {
    return substituteString(value, ctx, refusals)
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, ctx, refusals))
  }
  if (isLaunchConfigObject(value)) {
    return substituteObject(value, ctx, refusals)
  }
  return value
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

/** Expands launch variables through strings, arrays and objects; refuses rather than expanding what it cannot answer. */
export function substituteLaunchVariables(
  config: LaunchConfigObject,
  ctx: LaunchVariableContext
): LaunchVariableResult {
  const refusals: Refusals = { unsupported: [], needsFile: [] }
  const substituted = substituteObject(config, ctx, refusals)
  if (refusals.unsupported.length > 0) {
    const variables = unique(refusals.unsupported)
    return {
      ok: false,
      reason: 'unsupported-variable',
      variables,
      message: `${variables.join(', ')} cannot be answered by Orca; replace with a literal value.`
    }
  }
  if (refusals.needsFile.length > 0) {
    const variables = unique(refusals.needsFile)
    return {
      ok: false,
      reason: 'needs-file',
      variables,
      message: `${variables.join(', ')} needs an open file${
        variables.includes('${lineNumber}') ? ' and a cursor line' : ''
      }.`
    }
  }
  return { ok: true, value: substituted }
}

/** The unsupported variables a value names, without needing a file; for listing. */
export function unsupportedLaunchVariables(value: unknown): string[] {
  const refusals: Refusals = { unsupported: [], needsFile: [] }
  substituteValue(value, { worktreePath: '' }, refusals)
  return unique(refusals.unsupported)
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A deep copy of own keys only, minus the keys that reach a prototype. */
export function stripPrototypeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPrototypeKeys)
  }
  if (!isLaunchConfigObject(value)) {
    return value
  }
  const keys = Object.keys(value).filter((key) => !PROTOTYPE_KEYS.has(key))
  return Object.fromEntries(keys.map((key) => [key, stripPrototypeKeys(value[key])]))
}

/** JSON with object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (isLaunchConfigObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Over the UNRESOLVED configuration (plus any envFile's text), so it is one hash in every worktree. */
export function launchConfigHash(
  adapterId: string,
  config: LaunchConfigObject,
  envFileText: string | null = null
): string {
  const input = {
    adapterId,
    configuration: config,
    ...(envFileText === null ? {} : { envFileText })
  }
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  python: ['.py'],
  go: ['.go'],
  javascript: ['.js', '.mjs', '.cjs'],
  javascriptreact: ['.jsx'],
  typescript: ['.ts', '.mts', '.cts'],
  typescriptreact: ['.tsx'],
  c: ['.c', '.h'],
  cpp: ['.cc', '.cpp', '.cxx', '.hpp'],
  rust: ['.rs'],
  swift: ['.swift']
}

/** The language id an adapter row's `languages` would claim this file under, or null. */
export function languageIdForFile(filePath: string): string | null {
  const ext = posix.extname(filePath.replaceAll('\\', '/')).toLowerCase()
  const match = Object.entries(LANGUAGE_EXTENSIONS).find(([, exts]) => exts.includes(ext))
  return match?.[0] ?? null
}

const NODE_CURRENT_FILE = {
  type: 'node',
  request: 'launch',
  name: 'Node: current file',
  program: '${file}',
  cwd: '${workspaceFolder}'
}

/** The "Debug current file" templates by language id, variables unsubstituted. */
export const CURRENT_FILE_DEFAULTS: Record<string, LaunchConfigObject> = {
  python: {
    type: 'debugpy',
    request: 'launch',
    name: 'Python: current file',
    program: '${file}',
    cwd: '${workspaceFolder}',
    console: 'internalConsole',
    justMyCode: false
  },
  javascript: NODE_CURRENT_FILE,
  typescript: NODE_CURRENT_FILE,
  javascriptreact: NODE_CURRENT_FILE,
  typescriptreact: NODE_CURRENT_FILE,
  go: {
    type: 'go',
    request: 'launch',
    name: 'Go: current file',
    mode: 'debug',
    program: '${fileDirname}'
  }
}

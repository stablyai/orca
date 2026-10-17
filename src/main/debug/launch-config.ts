import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import {
  adapterForConfigType,
  DAP_ADAPTERS,
  type DapAdapterRow,
  type DapResolveOptions
} from './dap-adapter-registry'
import { describeLaunchRuns, readLaunchEnvFile, type LaunchRuns } from './launch-config-runs'
import {
  CURRENT_FILE_DEFAULTS,
  isLaunchConfigObject as isObject,
  languageIdForFile,
  launchConfigHash,
  stripPrototypeKeys,
  substituteLaunchVariables,
  unsupportedLaunchVariables,
  type LaunchConfigObject
} from './launch-config-variables'

export { languageIdForFile }

export type LaunchConfigRefusalReason =
  | 'malformed'
  | 'unreadable'
  | 'not-found'
  | 'compound'
  | 'unknown-type'
  | 'unsupported-request'
  | 'unsupported-variable'
  | 'needs-file'
  | 'no-default'

export type LaunchConfigRefusal = { ok: false; reason: LaunchConfigRefusalReason; message: string }

type LaunchFile = { configurations: LaunchConfigObject[]; compounds: LaunchConfigObject[] }

function refuse(reason: LaunchConfigRefusalReason, message: string): LaunchConfigRefusal {
  return { ok: false, reason, message }
}

function stringField(config: LaunchConfigObject, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function lineColumn(text: string, offset: number): string {
  const before = text.slice(0, offset).split('\n')
  return `${before.length}:${before.at(-1)!.length + 1}`
}

const JSONC_OPTIONS = { allowTrailingComma: true, disallowComments: false }

/** Parses launch.json text; any error refuses so the caller never falls back to a default. */
export function parseLaunchJson(
  text: string
): { ok: true; file: LaunchFile } | LaunchConfigRefusal {
  const errors: ParseError[] = []
  // jsonc-parser assigns keys, so `__proto__` would set a prototype the hash never sees.
  const root = stripPrototypeKeys(parse(text, errors, JSONC_OPTIONS))
  if (errors.length > 0) {
    const error = errors[0]
    return refuse(
      'malformed',
      `launch.json ${lineColumn(text, error.offset)}: ${printParseErrorCode(error.error)}`
    )
  }
  const configurations = isObject(root) ? (root.configurations ?? []) : null
  const compounds = isObject(root) ? (root.compounds ?? []) : null
  if (!Array.isArray(configurations) || !Array.isArray(compounds)) {
    return refuse(
      'malformed',
      'launch.json 1:1: expected an object whose configurations and compounds are arrays'
    )
  }
  return {
    ok: true,
    file: {
      configurations: configurations.filter(isObject),
      compounds: compounds.filter(isObject)
    }
  }
}

const LAUNCH_JSON_MAX_BYTES = 1024 * 1024

/** A missing launch.json is an empty file; a symlink, device or huge file is refused unread. */
export async function readLaunchJson(
  worktreePath: string
): Promise<{ ok: true; file: LaunchFile } | LaunchConfigRefusal> {
  const path = join(worktreePath, '.vscode', 'launch.json')
  let text: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > LAUNCH_JSON_MAX_BYTES) {
      return refuse('malformed', 'launch.json 1:1: must be a regular file of at most 1 MiB')
    }
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { ok: true, file: { configurations: [], compounds: [] } }
    }
    return refuse('unreadable', `launch.json: ${String(error)}`)
  }
  return parseLaunchJson(text)
}

export type LaunchConfigListing = {
  name: string
  kind: 'configuration' | 'compound'
  type: string
  request: string
  adapterId: string | null
  runnable: boolean
  refusal?: string
}

/** Why a configuration cannot run, checked before any file or variable is known. */
function checkConfiguration(
  config: LaunchConfigObject,
  table: readonly DapAdapterRow[] = DAP_ADAPTERS
): { ok: true; row: DapAdapterRow; request: 'launch' | 'attach' } | LaunchConfigRefusal {
  const name = stringField(config, 'name')
  const type = stringField(config, 'type')
  const row = adapterForConfigType(type, table)
  if (!row) {
    const what = type ? `type "${type}", which no debug adapter handles` : 'no type'
    return refuse('unknown-type', `"${name}" has ${what}`)
  }
  const request = stringField(config, 'request') || 'launch'
  if (request !== 'launch' && request !== 'attach') {
    return refuse('unsupported-request', `"${name}" has request "${request}", not launch or attach`)
  }
  const task = ['preLaunchTask', 'postDebugTask'].find((key) => key in config)
  if (task) {
    return refuse('unsupported-request', `"${name}" sets ${task}: tasks are not supported`)
  }
  const unsupported = unsupportedLaunchVariables(config)
  return unsupported.length > 0
    ? refuse(
        'unsupported-variable',
        `"${name}": ${unsupported.join(', ')} cannot be answered by Orca`
      )
    : { ok: true, row, request }
}

export async function listLaunchConfigs(
  worktreePath: string,
  table: readonly DapAdapterRow[] = DAP_ADAPTERS
): Promise<{ ok: true; configs: LaunchConfigListing[] } | LaunchConfigRefusal> {
  const read = await readLaunchJson(worktreePath)
  if (!read.ok) {
    return read
  }
  const configs = read.file.configurations.map((config): LaunchConfigListing => {
    const checked = checkConfiguration(config, table)
    return {
      name: stringField(config, 'name'),
      kind: 'configuration',
      type: stringField(config, 'type'),
      request: stringField(config, 'request'),
      adapterId: adapterForConfigType(stringField(config, 'type'), table)?.id ?? null,
      runnable: checked.ok,
      ...(checked.ok ? {} : { refusal: checked.message })
    }
  })
  // Listed rather than dropped, so a compound reads as unsupported instead of missing.
  const compounds = read.file.compounds.map((compound): LaunchConfigListing => ({
    name: stringField(compound, 'name'),
    kind: 'compound',
    type: '',
    request: '',
    adapterId: null,
    runnable: false,
    refusal: 'compound configurations are not supported'
  }))
  return { ok: true, configs: [...configs, ...compounds] }
}

/** The "Debug current file" template, variables unsubstituted. */
export function defaultConfigForFile(
  languageId: string
): { ok: true; config: LaunchConfigObject } | LaunchConfigRefusal {
  const config = CURRENT_FILE_DEFAULTS[languageId]
  return config
    ? { ok: true, config: { ...config } }
    : refuse(
        'no-default',
        `No "Debug current file" configuration for ${languageId}; add one to .vscode/launch.json.`
      )
}

// delve's `mode: debug` builds a package, so an injected program is the file's directory.
const PROGRAM_IS_DIRECTORY = new Set(['dlv'])

export type LaunchSpec = {
  /** Registry row id. */
  adapterId: string
  request: 'launch' | 'attach'
  /** The wire configuration: adapter defaults, substituted user keys, then the forced keys. */
  config: LaunchConfigObject
  /** The user's configuration (or the default template) with variables substituted, before any merge. */
  resolved: LaunchConfigObject
  name: string
  configHash: string
  /** Set when a terminal console was replaced: Orca answers no runInTerminal. */
  consoleForcedFrom?: string
  runs: LaunchRuns
}

export type ResolveLaunchSpecInput = {
  worktreePath: string
  configName?: string
  filePath?: string
  lineNumber?: number
  languageId?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  adapterOptions?: DapResolveOptions
  table?: readonly DapAdapterRow[]
}

async function pickConfiguration(
  input: ResolveLaunchSpecInput
): Promise<{ ok: true; config: LaunchConfigObject } | LaunchConfigRefusal> {
  // Read even for the file default: a malformed launch.json STOPS, it never falls back.
  const read = await readLaunchJson(input.worktreePath)
  if (!read.ok) {
    return read
  }
  if (input.configName !== undefined) {
    const named = read.file.configurations.find((c) => c.name === input.configName)
    if (named) {
      return { ok: true, config: named }
    }
    const isCompound = read.file.compounds.some((c) => c.name === input.configName)
    return isCompound
      ? refuse('compound', `"${input.configName}": compound configurations are not supported`)
      : refuse('not-found', `No configuration named "${input.configName}" in .vscode/launch.json`)
  }
  const languageId = input.languageId ?? (input.filePath ? languageIdForFile(input.filePath) : null)
  if (!languageId) {
    return input.filePath
      ? refuse('no-default', `No debug default for ${input.filePath}`)
      : refuse('needs-file', 'Open a file or pick a launch configuration.')
  }
  return defaultConfigForFile(languageId)
}

/** The ONE start path: every caller resolves its launch through here. */
export async function resolveLaunchSpec(
  input: ResolveLaunchSpecInput
): Promise<{ ok: true; spec: LaunchSpec } | LaunchConfigRefusal> {
  const picked = await pickConfiguration(input)
  if (!picked.ok) {
    return picked
  }
  const unresolved = picked.config
  const checked = checkConfiguration(unresolved, input.table)
  if (!checked.ok) {
    return checked
  }
  const { row, request } = checked
  const name = stringField(unresolved, 'name')
  const substituted = substituteLaunchVariables(unresolved, input)
  if (!substituted.ok) {
    return refuse(substituted.reason, `"${name}": ${substituted.message}`)
  }
  const resolved = substituted.value
  const envFile = await readLaunchEnvFile(input.worktreePath, resolved.envFile)
  if (!envFile.ok) {
    return refuse('malformed', `"${name}": ${envFile.message}`)
  }
  const wire = (user: LaunchConfigObject): LaunchConfigObject => {
    const merged: LaunchConfigObject = { ...row.launchDefaults, ...user, type: row.wireType }
    if (row.workspaceFolderKey) {
      merged[row.workspaceFolderKey] = input.worktreePath
    }
    if (request === 'launch' && merged.program === undefined && input.filePath) {
      merged.program = PROGRAM_IS_DIRECTORY.has(row.id) ? dirname(input.filePath) : input.filePath
    }
    merged.request = request
    return merged
  }
  const config = wire(resolved)
  let consoleForcedFrom: string | undefined
  if (config.console === 'integratedTerminal' || config.console === 'externalTerminal') {
    consoleForcedFrom = config.console
    config.console = 'internalConsole'
  }
  // The confirmation shows ${env:NAME} as written: resolving it would display main's secrets.
  const shown = substituteLaunchVariables(unresolved, { ...input, keepEnv: true })
  const runs = await describeLaunchRuns(
    row,
    shown.ok ? wire(shown.value) : config,
    { ...input.adapterOptions, worktreePath: input.worktreePath },
    envFile.text
  )
  return {
    ok: true,
    spec: {
      adapterId: row.id,
      request,
      config,
      resolved,
      name: name || row.label,
      configHash: launchConfigHash(row.id, unresolved, envFile.text),
      ...(consoleForcedFrom ? { consoleForcedFrom } : {}),
      runs
    }
  }
}

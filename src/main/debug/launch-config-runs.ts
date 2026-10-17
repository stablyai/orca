import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import {
  resolveDebugAdapter,
  type DapAdapterRow,
  type DapResolveOptions
} from './dap-adapter-registry'
import { isLaunchConfigObject, type LaunchConfigObject } from './launch-config-variables'

const MASKED_ENV_KEY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
// Each one changes what code the debuggee loads before the program runs.
const DANGEROUS_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH'
])

export type LaunchRunsEnvEntry = {
  name: string
  value: string | null
  masked: boolean
  dangerous: boolean
}

/** One wire-config key as the confirmation shows it: strings as written, the rest as JSON. */
export type LaunchRunsKeyEntry = { name: string; value: string; dangerous: boolean }

const RUNS_FIELDS = [
  'program',
  'args',
  'cwd',
  'module',
  'python',
  'runtimeExecutable',
  'runtimeArgs',
  'envFile',
  'processId',
  'host',
  'port'
] as const

/** What the confirmation shows before anything runs; absent keys are null. */
export type LaunchRuns = Record<(typeof RUNS_FIELDS)[number], unknown> & {
  adapterBinary: string | null
  adapterArgs: string[] | null
  /** The adapter binary sits in the worktree, so anything that writes the repo can change it. */
  adapterRepoLocal: boolean
  env: LaunchRunsEnvEntry[]
  /** Every key the adapter receives, sorted, so nothing runs that the person did not see. */
  allKeys: LaunchRunsKeyEntry[]
  /** The envFile's KEY=VALUE lines, masked and flagged like env. */
  envFileEntries: LaunchRunsEnvEntry[]
}

// Each one makes the adapter run a command, a build flag or another binary before the program.
const DANGEROUS_LAUNCH_KEY =
  /Commands$|^(buildFlags|pythonArgs|sudo|runtimeExecutable|runtimeArgs)$/

function describeEnv(env: unknown): LaunchRunsEnvEntry[] {
  if (!isLaunchConfigObject(env)) {
    return []
  }
  return Object.entries(env).map(([name, raw]) => {
    const masked = MASKED_ENV_KEY.test(name)
    const value = raw === null || raw === undefined ? null : String(raw)
    return {
      name,
      value: masked && value !== null ? '••••••' : value,
      masked,
      dangerous: DANGEROUS_ENV_KEYS.has(name)
    }
  })
}

/** dotenv's KEY=VALUE lines; blank lines, comments and `export ` prefixes are skipped. */
export function parseEnvFileText(text: string): LaunchConfigObject {
  const entries = text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : []
  })
  return Object.fromEntries(entries)
}

function describeAllKeys(row: DapAdapterRow, config: LaunchConfigObject): LaunchRunsKeyEntry[] {
  const masked = Object.fromEntries(describeEnv(config.env).map((e) => [e.name, e.value]))
  return Object.keys(config)
    .filter((name) => name !== row.workspaceFolderKey)
    .sort()
    .map((name) => {
      const raw = name === 'env' && isLaunchConfigObject(config.env) ? masked : config[name]
      const value = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? 'null')
      return { name, value, dangerous: DANGEROUS_LAUNCH_KEY.test(name) }
    })
}

export async function describeLaunchRuns(
  row: DapAdapterRow,
  config: LaunchConfigObject,
  options: DapResolveOptions,
  envFileText: string | null = null
): Promise<LaunchRuns> {
  const python = typeof config.python === 'string' ? config.python : undefined
  const adapter = await resolveDebugAdapter(row, { ...options, pythonOverride: python })
  const fields = Object.fromEntries(RUNS_FIELDS.map((key) => [key, config[key] ?? null]))
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fromEntries over RUNS_FIELDS sets every key.
    ...(fields as Record<(typeof RUNS_FIELDS)[number], unknown>),
    adapterBinary: adapter.ok ? adapter.binaryPath : null,
    adapterArgs: adapter.ok ? adapter.args : null,
    adapterRepoLocal: adapter.ok && adapter.repoLocal,
    env: describeEnv(config.env),
    allKeys: describeAllKeys(row, config),
    envFileEntries: envFileText === null ? [] : describeEnv(parseEnvFileText(envFileText))
  }
}

const ENV_FILE_MAX_BYTES = 64 * 1024

/** The envFile's text, hashed and shown: it changes what runs as much as launch.json does. */
export async function readLaunchEnvFile(
  worktreePath: string,
  envFile: unknown
): Promise<{ ok: true; text: string | null } | { ok: false; message: string }> {
  if (envFile === undefined) {
    return { ok: true, text: null }
  }
  const message = `envFile ${JSON.stringify(envFile)} must be a regular file of at most 64 KiB in the worktree`
  const path = typeof envFile === 'string' ? resolve(worktreePath, envFile) : ''
  try {
    const [info, real, root] = await Promise.all([
      lstat(path),
      realpath(path),
      realpath(worktreePath)
    ])
    if (info.isFile() && info.size <= ENV_FILE_MAX_BYTES && real.startsWith(root + sep)) {
      return { ok: true, text: await readFile(path, 'utf8') }
    }
  } catch {
    // Missing or unreadable is refused like any other bad envFile.
  }
  return { ok: false, message }
}
